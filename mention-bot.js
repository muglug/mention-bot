/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 */

'use strict';

var githubAuthCookies = require('./githubAuthCookies');
var config = require('./package.json').config;
var fs = require('fs');
var minimatch = require('minimatch');

async function downloadFileAsync(url: string, cookies: ?string, headers: ?Array): Promise<string> {
  return new Promise(function(resolve, reject) {
    var args = ['--silent', '-L', url];

    if (cookies) {
      args.push('-H', `Cookie: ${cookies}`);
    }
    if (headers) {
      headers.forEach(function (header) {
        args.push('-H', header);
      });
    }

    require('child_process')
      .execFile('curl', args, {encoding: 'utf8', maxBuffer: 1000 * 1024}, function(error, stdout, stderr) {
        if (error) {
          reject(error);
        } else {
          resolve(stdout.toString());
        }
      });
  });
}

async function readFileAsync(name: string, encoding: string): Promise<string> {
  return new Promise(function(resolve, reject) {
    fs.readFile(name, encoding, function(err, data) {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
}

type FileInfo = {
  path: string,
  deletedLines: Array<number>,
};

type WhitelistUser = {
  name: string,
  files: Array<string>
};

function startsWith(str, start) {
  return str.substr(0, start.length) === start;
}

function parseDiffFile(lines: Array<string>): FileInfo {
  var deletedLines = [];

  // diff --git a/path b/path
  var line = lines.pop();
  if (!line.match(/^diff --git a\//)) {
    throw new Error('Invalid line, should start with `diff --git a/`, instead got \n' + line + '\n');
  }
  var fromFile = line.replace(/^diff --git a\/(.+) b\/.+/g, '$1');

  // index sha..sha mode
  line = lines.pop();
  if (startsWith(line, 'deleted file') ||
      startsWith(line, 'new file')) {
    line = lines.pop();
  }

  line = lines.pop();
  if (startsWith(line, 'Binary files')) {
    // We just ignore binary files (mostly images). If we want to improve the
    // precision in the future, we could look at the history of those files
    // to get more names.
  } else if (startsWith(line, '--- ')) {
    // +++ path
    line = lines.pop();
    if (!line.match(/^\+\+\+ /)) {
      throw new Error('Invalid line, should start with `+++`, instead got \n' + line + '\n');
    }

    var currentFromLine = 0;
    while (lines.length > 0) {
      line = lines.pop();
      if (startsWith(line, 'diff --git')) {
        lines.push(line);
        break;
      }

      // @@ -from_line,from_count +to_line,to_count @@ first line
      if (startsWith(line, '@@')) {
        var matches = line.match(/^\@\@ -([0-9]+),?([0-9]+)? \+([0-9]+),?([0-9]+)? \@\@/);
        if (!matches) {
          continue;
        }

        var from_line = matches[1];
        var from_count = matches[2];
        var to_line = matches[3];
        var to_count = matches[4];

        currentFromLine = +from_line;
        continue;
      }

      if (startsWith(line, '-')) {
        deletedLines.push(currentFromLine);
      }
      if (!startsWith(line, '+')) {
        currentFromLine++;
      }
    }
  }

  return {
    path: fromFile,
    deletedLines: deletedLines,
  };
}

function parseDiff(diff: string): Array<FileInfo> {
  var files = [];
  // The algorithm is designed to be best effort. If the http request failed
  // for some reason and we get an empty file, we should not crash.
  if (!diff || !diff.match(/^diff/)) {
    return files;
  }

  var lines = diff.trim().split('\n');
  // Hack Array doesn't have shift/unshift to work from the beginning of the
  // array, so we reverse the entire array in order to be able to use pop/add.
  lines.reverse();

  while (lines.length > 0) {
    files.push(parseDiffFile(lines));
  }

  return files;
}

function parseBlame(lines: Array<string>): Array<string> {
  var lineNumber = 1;
  var author;
  var authors = [];
  
  lines.forEach(function(line) {
    if (line.substring(0, 11) === 'author-mail') {
      author = line.substring(12).replace(/[\<\>]/g, '');
      
      if (authors.length === 0) {
        authors.push(author);
      }
    }
    else if (line.match(/^[0-9a-f]{40} /) && author) {
      authors.push(author);
    }
  });

  return authors;
}

async function getBlame(path: string): Promise<string> {
  return new Promise(function(resolve, reject) {
    var cmd = 'git';
    require('child_process')
      .execFile(cmd, ['blame', '-p', path], {cwd: process.env.GITHUB_DIR, encoding: 'utf8', maxBuffer: 50000 * 1024}, function(error, stdout, stderr) {
        if (error) {
          reject(error);
        } else {
          var output = stdout.toString();
          resolve(output.split('\n').map(function(line) {
            return line.replace(/^[0-9a-f]{8} \(<([^>]*)>.*$/, '$1');
          }));
        }
      });
  });
}

function getDeletedOwners(
  files: Array<FileInfo>,
  blames: { [key: string]: Array<string> }
): { [key: string]: number } {
  var owners = {};
  files.forEach(function(file) {
    var blame = blames[file['path']];
    if (!blame) {
      return;
    }
    file.deletedLines.forEach(function (line) {
      // In a perfect world, this should never fail. However, in practice, the
      // blame request may fail, the blame is checking against master and the
      // pull request isn't, the blame file was too big and the curl wrapper
      // only read the first n bytes...
      // Since the output of the algorithm is best effort, it's better to just
      // swallow errors and have a less accurate implementation than to crash.
      var name = blame[line - 1];
      if (!name) {
        return;
      }
      owners[name] = (owners[name] || 0) + 1;
    });
  });
  return owners;
}

function getAllOwners(
  files: Array<FileInfo>,
  blames: { [key: string]: Array<string> }
): { [key: string]: number } {
  var owners = {};
  files.forEach(function(file) {
    var blame = blames[file.path];
    if (!blame) {
      return;
    }
    for (var i = 0; i < blame.length; ++i) {
      var name = blame[i];
      if (!name) {
        return;
      }
      owners[name] = (owners[name] || 0) + 1;
    }
  });
  return owners;
}

function getSortedOwners(
  owners: { [key: string]: number }
): Array<string> {
  var sorted_owners = Object.keys(owners);
  sorted_owners.sort(function(a, b) {
    var countA = owners[a];
    var countB = owners[b];
    return countA > countB ? -1 : (countA < countB ? 1 : 0);
  });
  return sorted_owners;
}

function getDefaultOwners(
  files: Array<FileInfo>,
  whitelist: Array<WhitelistUser>
): Array<string> {
  var owners = [];
  var users = whitelist || [];

  users.forEach(function(user) {
    let userHasChangedFile = false;

    user.files.forEach(function(pattern) {
      if (!userHasChangedFile) {
        userHasChangedFile = files.find(function(file) {
          return minimatch(file.path, pattern);
        });
      }
    });

    if (userHasChangedFile && owners.indexOf(user.name) === -1) {
      owners.push(user.name);
    }
  });

  return owners;
}

/**
 * While developing/debugging the algorithm itself, it's very important not to
 * make http requests to github. Not only it's going to make the reload cycle
 * much slower, it's also going to temporary/permanently ban your ip and
 * you won't be able to get anymore work done when it happens :(
 */
async function fetch(url: string, headers): Promise<string> {
  if (!module.exports.enableCachingForDebugging) {
    return downloadFileAsync(url, githubAuthCookies, headers);
  }

  var cacheDir = __dirname + '/cache/';

  if (!fs.existsSync(cacheDir)) {
    fs.mkdir(cacheDir);
  }
  var cache_key = cacheDir + url.replace(/[^a-zA-Z0-9-_\.]/g, '-');
  if (!fs.existsSync(cache_key)) {
    var file = await downloadFileAsync(url, githubAuthCookies);
    fs.writeFileSync(cache_key, file);
  }
  return readFileAsync(cache_key, 'utf8');
}

async function getOwnerOrgs(
  owner: string,
  github: Object
): Promise<Array<string>> {
  return new Promise(function(resolve, reject) {
    github.orgs.getFromUser({ user: owner }, function(err, result) {
      if (err) {
        reject(err);
      } else {
        resolve(
          result.map(function (obj){
            return obj.login;
          })
        );
      }
    });
  });
}

async function filterRequiredOrgs(
  owners: Array<string>,
  repoConfig: Object,
  github: Object
): Promise<Array<string>> {
  var promises = owners.map(function(owner) {
    return getOwnerOrgs(owner, github);
  });

  var userOrgs = await Promise.all(promises);
  return owners.filter(function(owner, index) {
    // user passes if he is in any of the required organizations
    return repoConfig.requiredOrgs.some(function(reqOrg) {
      return userOrgs[index].indexOf(reqOrg) >= 0;
    });
  });
}

async function replaceEmailWithUser(
  email: string,
  github: Object,
  config: Object
): Promise<string> {
  return new Promise(function(resolve, reject) {
    if (config.emailAliases && config.emailAliases[email]) {
      resolve(config.emailAliases[email]);

    } else if (config.ghe.emailDomain && email.indexOf('@' + config.ghe.emailDomain) > -1) {
      resolve(email.replace('@' + config.ghe.emailDomain, ''));

    } else if (email.indexOf('@') > -1) {
      github.search.email({'email': email}, function(error, result) {
        if (error) {
          resolve(email);
        } else {
          resolve(result.user.login);
        }
      });

    }
    else {
      resolve(email);
    }
  });
}

async function blankIfDead(
  user: string,
  github: Object
): Promise<string> {
  return new Promise(function(resolve, reject) {
    if (user.indexOf('@') === -1) {
      github.user.get({user: user}, function(error, result) {
        if (error) {
          resolve(user);
        }
        else {
          if (result.suspended_at === null) {
            resolve(user);
          }
          else {
            resolve('');
          }
        }
      });
    }
    else {
      resolve(user);
    }
  });
}

/**
 * The problem at hand is to find a set of three best effort people that have
 * context on a pull request. It doesn't (and actually can't) be perfect.
 *
 * The most precise information we have is when someone deletes or modifies
 * a line of code. We know who last touched those lines and they are most
 * likely good candidates for reviewing the code.
 * This is of course not always the case, people can codemod big number of
 * lines and have very little context on that particular one, people move
 * file around and absorb all the blame...
 *
 * But, not all pull requests modify code, many of them just add new lines.
 * I first played with giving credit to people that blamed the lines around
 * but it was unclear how to spread out the credit.
 * A much dumber strategy but which has proven to be effective is to
 * completely ignore new lines and instead find the people that are blamed
 * for the biggest number of lines in the file.
 *
 * Given those two observations, the algorithm is as follow:
 *  - For each line that has been deleted, give 1 ponumber to the blamed author
 *    in a 'deletedOwners' pool.
 *  - For each file that has been touched, for each line in that file, give 1
 *    ponumber to the blamed author in a 'allOwners' pool.
 *  Once you've got those two pools, sort them by number of points, dedupe
 *  them, concat them and finally take the first 3 names.
 */
async function guessOwners(
  files: Array<FileInfo>,
  blames: { [key: string]: Array<string> },
  creator: string,
  defaultOwners: Array<string>,
  repoConfig: Object,
  github: Object
): Promise<Array<string>> {
  var deletedOwners = getDeletedOwners(files, blames);
  var allOwners = getAllOwners(files, blames);

  deletedOwners = getSortedOwners(deletedOwners);
  allOwners = getSortedOwners(allOwners);

  // Remove owners that are also in deletedOwners
  var deletedOwnersSet = new Set(deletedOwners);
  var allOwners = allOwners.filter(function(element) {
    return !deletedOwnersSet.has(element);
  });

  var owners = []
    .concat(deletedOwners)
    .concat(allOwners)
    .filter(function(owner) {
      return owner !== 'none';
    })
    .filter(function(owner) {
      return owner !== creator;
    })
    .filter(function(owner) {
      return repoConfig.userBlacklist.indexOf(owner) === -1;
    });

  if (repoConfig.requiredOrgs.length > 0) {
    owners = await filterRequiredOrgs(owners, repoConfig, github);
  }

  var replacePromises = owners.map(function(owner) {
    return replaceEmailWithUser(owner, github, config);
  });

  owners = await Promise.all(replacePromises);

  owners = [...new Set(owners)];

  var currentPromises = owners.map(function(owner) {
    return blankIfDead(owner, github);
  });

  owners = await Promise.all(currentPromises);

  owners = owners.filter(function(owner) {
    return owner !== '';
  });

  return owners
    .slice(0, repoConfig.maxReviewers)
    .concat(defaultOwners)
    .filter(function(owner, index, ownersFound) {
      return ownersFound.indexOf(owner) === index;
    });
}

async function getDiff(
  repoURI: string,
  id: int,
  config: Object
) : Promise<Array<string>> {
  var apiUrl = (config.ghe.protocol || 'https') + '://' + (config.ghe.host || 'api.github.com') + (config.ghe.pathPrefix || '') + '/';
  var pullUrl = apiUrl + 'repos/' + repoURI + '/pulls/' + id;
  
  return fetch(pullUrl, [
    'Accept: application/vnd.github.v3.diff',
    'Authorization: token ' + process.env.GITHUB_TOKEN
  ]);
}

async function guessOwnersForPullRequest(
  repoURI: string,
  id: number,
  creator: string,
  targetBranch: string,
  repoConfig: Object,
  github: Object
): Promise<Array<string>> {
  var diff = await getDiff(repoURI, id, config);
  var files = parseDiff(diff);
  var defaultOwners = getDefaultOwners(files, repoConfig.alwaysNotifyForPaths);

  if (!repoConfig.findPotentialReviewers) {
      return defaultOwners;
  }

  // There are going to be degenerated changes that end up modifying hundreds
  // of files. In theory, it would be good to actually run the algorithm on
  // all of them to get the best set of reviewers. In practice, we don't
  // want to do hundreds of http requests. Using the top 5 files is enough
  // to get us 3 people that may have context.
  files.sort(function(a, b) {
    var countA = a.deletedLines.length;
    var countB = b.deletedLines.length;
    return countA > countB ? -1 : (countA < countB ? 1 : 0);
  });
  // remove files that match any of the globs in the file blacklist config
  repoConfig.fileBlacklist.forEach(function(glob) {
    files = files.filter(function(file) {
      return !minimatch(file.path, glob);
    });
  });
  files = files.slice(0, repoConfig.numFilesToCheck);

  var blames = {};
  // create blame promises (allows concurrent loading)
  var promises = files.map(function(file) {
    return getBlame(file.path);
  });

  // wait for all promises to resolve
  var results = await Promise.all(promises);
  results.forEach(function(result, index) {
    blames[files[index].path] = parseBlame(result);
  });

  // This is the line that implements the actual algorithm, all the lines
  // before are there to fetch and extract the data needed.
  return guessOwners(files, blames, creator, defaultOwners, repoConfig, github);
}

module.exports = {
  enableCachingForDebugging: false,
  parseDiff: parseDiff,
  parseBlame: parseBlame,
  guessOwnersForPullRequest: guessOwnersForPullRequest,
};
