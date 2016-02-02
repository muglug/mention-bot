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

var bl = require('bl');
var config = require('./package.json').config;
var express = require('express');
var fs = require('fs');
var mentionBot = require('./mention-bot.js');
var messageGenerator = require('./message.js');
var util = require('util');

var GitHubApi = require('github');

var CONFIG_PATH = '.mention-bot';

if (!process.env.GITHUB_DIR) {
  console.error('The bot was started without a github directory specified.');
  process.exit(1);
}

if (!process.env.GITHUB_TOKEN) {
  console.error('The bot was started without a github account to post with.');
  console.error('To get started:');
  console.error('1) Create a new account for the bot');
  console.error('2) Settings > Personal access tokens > Generate new token');
  console.error('3) Only check `public_repo` and click Generate token');
  console.error('4) Run the following command:');
  console.error('GITHUB_TOKEN=insert_token_here npm start');
  console.error('5) Run the following command in another tab:');
  console.error('curl -X POST -d @__tests__/data/23.webhook http://localhost:5000/');
  console.error('6) Check that it commented here: https://github.com/fbsamples/bot-testing/pull/23');
  process.exit(1);
}

if (!process.env.GITHUB_USER) {
  console.warn(
    'There was no github user detected.',
    'This is fine, but mention-bot won\'t work with private repos.'
  );
  console.warn(
    'To make mention-bot work with private repos, please expose',
    'GITHUB_USER and GITHUB_PASSWORD as environment variables.',
    'The user and password must have access to the private repo',
    'you want to use.'
  );
}

var github = new GitHubApi({
  version: '3.0.0',
  host: config.ghe.host,
  pathPrefix: config.ghe.pathPrefix,
  protocol: config.ghe.protocol || 'https',
  port: config.ghe.port || '443'
});

github.authenticate({
  type: 'oauth',
  token: process.env.GITHUB_TOKEN
});

var app = express();

function buildMentionSentence(reviewers) {
  var atReviewers = reviewers.map(function(owner) { return '@' + owner; });

  if (reviewers.length === 1) {
    return atReviewers[0];
  }

  return (
    atReviewers.slice(0, atReviewers.length - 1).join(', ') +
    ' and ' + atReviewers[atReviewers.length - 1]
  );
}

function defaultMessageGenerator(reviewers) {
  return util.format(
    'Using `git blame`, identified %s to be%s potential reviewer%s',
     buildMentionSentence(reviewers),
     reviewers.length > 1 ? '' : ' a',
     reviewers.length > 1 ? 's' : ''
  );
}

function getRepoConfig(request) {
  return new Promise(function(resolve, reject) {
    github.repos.getContent(request, function(err, result) {
      if(err) {
        reject(err);
      }
      resolve(result);
    });
  });
}

async function work(body) {
  console.log('received data');

  var data = {};
  try {
    data = JSON.parse(body.toString());
  } catch (e) {
    console.error(e);
  }

  // default config
  var repoConfig = {
    maxReviewers: 5,
    numFilesToCheck: 5,
    userBlacklist: [],
    userBlacklistForPR: [],
    userWhitelist: [],
    fileBlacklist: [],
    requiredOrgs: [],
    findPotentialReviewers: true,
    actions: ['opened'],
  };

  try {
    // request config from repo
    var configRes = await getRepoConfig({
      user: data.repository.owner.login,
      repo: data.repository.name,
      path: CONFIG_PATH,
      headers: {
        Accept: 'application/vnd.github.v3.raw'
      }
    });

    repoConfig = {...repoConfig, ...JSON.parse(configRes)};
  } catch (e) {
    console.log('Could not locate file ' + CONFIG_PATH + ' in repository ' + data.repository.name);
  }

  var pullRequest;
  var creator;
  var messageBody;
  var pullRequestNumber;

  if (data.issue && data.issue.pull_request && data.comment && data.action === 'created') {
    pullRequest = data.issue.pull_request;
    creator = data.comment.user;
    pullRequestNumber = data.issue.number;
    messageBody = data.comment.body;
  }
  else if (data.pull_request) {
    if (repoConfig.actions.indexOf(data.action) === -1) {
      console.log(
        'Skipping because action is ' + data.action + '.',
        'We only care about: "' + repoConfig.actions.join("', '") + '"'
      );
      return;
    }

    pullRequest = data.pull_request;
    creator = pullRequest.user;
    messageBody = data.pull_request.body;
  }
  else if (data.issue && data.issue.pull_request === undefined && data.comment) {
    console.log('Skipping because it is an issue comment');
    return;
  }
  else {
    console.log('Skipping because not a pull request or PR comment');
    console.log(data);
    return;
  }

  if (messageBody.indexOf('git blame') > -1) {
    console.log('Skipping because it is a mention-bot comment');
    return;
  }

  if (process.env.REQUIRED_ORG) {
    repoConfig.requiredOrgs.push(process.env.REQUIRED_ORG);
  }

  if (repoConfig.userBlacklistForPR.indexOf(creator.login) >= 0) {
    console.log('Skipping because blacklisted user created Pull Request.');
    return;
  }

  if (config.triggers) {
    var found = false;
    var tokenizedBody = messageBody.toLowerCase().split(/[\n\s]+/);

    for (var i = 0; i < config.triggers.length; i++) {
      if (tokenizedBody.includes(config.triggers[i].toLowerCase())) {
        found = true;
      }
    }

    if (!found) {
      console.log('Skipping because no trigger words found.');
      return;
    }
  }

  var reviewers = await mentionBot.guessOwnersForPullRequest(
    data.repository.html_url.split('/').slice(3).join('/'), // 'fbsamples/bot-testing'
    pullRequestNumber, // 23
    creator.login, // 'mention-bot'
    pullRequest.base ? pullRequest.base.ref : 'master', // 'master'
    repoConfig,
    github
  );

  console.log(pullRequest.html_url, reviewers);

  if (reviewers.length === 0) {
    console.log('Skipping because there are no reviewers found.');
    return;
  }

  github.issues.createComment({
    user: data.repository.owner.login, // 'fbsamples'
    repo: data.repository.name, // 'bot-testing'
    number: pullRequestNumber, // 23
    body: messageGenerator(
      reviewers,
      buildMentionSentence,
      defaultMessageGenerator
    )
  });

  return;
};

app.post('/', function(req, res) {
  req.pipe(bl(function(err, body) {
    work(body).then(function() { res.end(); });
 }));
});

app.get('/', function(req, res) {
  res.send(
    'GitHub Mention Bot Active. ' +
    'Go to https://github.com/facebook/mention-bot for more information.'
  );
});

app.set('port', process.env.PORT || 5000);

app.listen(app.get('port'), function() {
  console.log('Listening on port', app.get('port'));
});
