import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export function validateRelease(repository, commit, image) {
  assert.equal(repository, 'fakebane/tricord-public', 'Only the intended repository may deploy.');
  assert.match(commit, /^[a-f0-9]{40}$/, 'Use a full commit SHA.');
  if (image !== undefined)
    assert.match(
      image,
      /^ghcr\.io\/fakebane\/tricord-public@sha256:[a-f0-9]{64}$/,
      'Use an immutable image digest.',
    );
}

export function validateProduction(environment) {
  assert.ok(
    environment.protection_rules?.some(
      (rule) => rule.type === 'required_reviewers' && rule.reviewers?.length > 0,
    ),
    'Production requires a configured GitHub environment reviewer.',
  );
  assert.equal(
    environment.can_admins_bypass,
    false,
    'Disable administrator bypass for production; its setting must be explicitly verified.',
  );
  assert.equal(
    environment.deployment_branch_policy?.custom_branch_policies,
    true,
    'Restrict production to selected main branch.',
  );
}

export async function checkPolicy(mode, env = process.env) {
  validateRelease(env.GITHUB_REPOSITORY, env.GITHUB_SHA, env.TRICORD_IMAGE);
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Only main may release.');
  const request = async (endpoint) => {
    const response = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${endpoint}`,
      {
        headers: {
          Authorization: `Bearer ${env.GH_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    assert.ok(response.ok, `GitHub policy request failed (${response.status}).`);
    return response.json();
  };
  const main = await request('git/ref/heads/main');
  assert.equal(
    main.object.sha,
    env.GITHUB_SHA,
    'This release was superseded by newer main changes.',
  );
  if (mode === 'production') {
    validateProduction(await request('environments/production'));
    const branches = await request(
      'environments/production/deployment-branch-policies?per_page=100',
    );
    assert.equal(
      branches.total_count,
      1,
      'Production must have exactly one deployment branch policy.',
    );
    assert.equal(
      branches.branch_policies?.[0]?.name,
      'main',
      'Only main may deploy to production.',
    );
    assert.equal(
      branches.branch_policies?.[0]?.type,
      'branch',
      'Production must allow a branch, not a tag.',
    );
  } else assert.equal(mode, 'main', 'Unknown release policy.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkPolicy(process.argv[2]);
    console.log('Release policy passed.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
