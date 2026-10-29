import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateProduction } from './policy.mjs';

// Desktop releases use the transferred repository; server deployment policy is unchanged.
assert.equal(process.env.GITHUB_REPOSITORY, 'Treca-Raja/rajcord-public');
assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Only main may release.');
assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/, 'Use a full commit SHA.');
const { version } = JSON.parse(fs.readFileSync('apps/desktop/package.json', 'utf8'));
assert.match(version, /^\d+\.\d+\.\d+$/, 'Stable Windows releases use a numeric SemVer.');
assert.equal(
  process.env.RAJCORD_RELEASE_TAG,
  `v${version}`,
  'Confirm the exact desktop version tag.',
);
const request = async (endpoint) => {
  const response = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${endpoint}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
    },
  );
  assert.ok(response.ok, `Desktop release policy request failed (${response.status}).`);
  return response.json();
};
const main = await request('git/ref/heads/main');
assert.equal(
  main.object.sha,
  process.env.GITHUB_SHA,
  'This release was superseded by newer main changes.',
);
validateProduction(await request('environments/desktop-release'));
const branches = await request(
  'environments/desktop-release/deployment-branch-policies?per_page=100',
);
assert.equal(branches.total_count, 1);
assert.equal(branches.branch_policies?.[0]?.name, 'main');
assert.equal(branches.branch_policies?.[0]?.type, 'branch');
const runs = await request(
  `actions/workflows/verify.yml/runs?head_sha=${process.env.GITHUB_SHA}&per_page=100`,
);
assert.ok(
  runs.workflow_runs.some(
    (run) =>
      run.head_sha === process.env.GITHUB_SHA &&
      run.head_repository?.full_name === process.env.GITHUB_REPOSITORY &&
      run.head_branch === 'main' &&
      run.event === 'push' &&
      run.conclusion === 'success',
  ),
  'The exact main commit must have passed the full Verify workflow first.',
);
console.log('Desktop draft release policy passed.');
