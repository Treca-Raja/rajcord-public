import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function validatePullRequest(pullRequest) {
  const base = pullRequest?.base;
  const head = pullRequest?.head;
  assert.ok(base?.repo?.full_name && head?.repo?.full_name, 'PR repository data is required.');
  if (base.ref === 'main') {
    assert.equal(head.ref, 'develop', 'Release PRs must go from develop to main.');
    assert.equal(
      head.repo.full_name.toLowerCase(),
      base.repo.full_name.toLowerCase(),
      'Release PRs must use develop from the same repository.',
    );
  } else {
    assert.equal(base.ref, 'develop', 'Feature PRs must target develop.');
    assert.match(
      head.ref ?? '',
      /^(feature|dependabot)\/.+$/,
      'Use feature/* (or dependabot/* for dependency updates) into develop.',
    );
  }
}

export function checkPullRequest(env = process.env) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request') return;
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  validatePullRequest(event.pull_request);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkPullRequest();
  console.log('PR branch policy passed.');
}
