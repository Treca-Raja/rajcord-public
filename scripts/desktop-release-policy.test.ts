import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const repository = 'Treca-Raja/rajcord-public';
const sha = 'a'.repeat(40);
const { version } = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8'));
let environment: Record<string, unknown>;
let branches: Record<string, unknown>;
let runs: Record<string, unknown>;
let main: string;
let fetchMock: ReturnType<typeof vi.fn>;

async function check() {
  vi.resetModules();
  // @ts-expect-error JavaScript release policy is executed directly by Node in CI.
  await import('./ci/desktop-release.mjs');
}

beforeEach(() => {
  vi.stubEnv('GITHUB_REPOSITORY', repository);
  vi.stubEnv('GITHUB_REF', 'refs/heads/main');
  vi.stubEnv('GITHUB_SHA', sha);
  vi.stubEnv('RAJCORD_RELEASE_TAG', `v${version}`);
  vi.stubEnv('GH_TOKEN', 'disposable-test');
  main = sha;
  environment = {
    can_admins_bypass: false,
    deployment_branch_policy: { custom_branch_policies: true },
    protection_rules: [{ type: 'required_reviewers', reviewers: [{ id: 1 }] }],
  };
  branches = { total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] };
  runs = {
    workflow_runs: [
      {
        head_sha: sha,
        head_repository: { full_name: repository },
        head_branch: 'main',
        event: 'push',
        conclusion: 'success',
      },
    ],
  };
  fetchMock = vi.fn(async (url: string) => {
    const prefix = `https://api.github.com/repos/${repository}/`;
    expect(url.startsWith(prefix)).toBe(true);
    const endpoint = url.slice(prefix.length);
    let response;
    if (endpoint === 'git/ref/heads/main') response = { object: { sha: main } };
    else if (endpoint === 'environments/desktop-release') response = environment;
    else if (endpoint === 'environments/desktop-release/deployment-branch-policies?per_page=100')
      response = branches;
    else if (endpoint === `actions/workflows/verify.yml/runs?head_sha=${sha}&per_page=100`)
      response = runs;
    else throw new Error('Unexpected policy API request.');
    return new Response(JSON.stringify(response));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

it('accepts only the canonical repository with current main, approval and successful verification', async () => {
  await expect(check()).resolves.toBeUndefined();
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it.each(['Treca-Raja/tricord-public', 'fakebane/tricord-public', 'other/rajcord-public'])(
  'rejects former or unapproved repository %s before network access',
  async (value) => {
    vi.stubEnv('GITHUB_REPOSITORY', value);
    await expect(check()).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it.each(['refs/heads/develop', 'refs/heads/feature/test', 'refs/tags/main', 'refs/pull/11/merge'])(
  'keeps release publication disabled on %s',
  async (value) => {
    vi.stubEnv('GITHUB_REF', value);
    await expect(check()).rejects.toThrow('Only main');
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it('rejects invalid commit/version confirmations before network access', async () => {
  vi.stubEnv('GITHUB_SHA', 'not-a-sha');
  await expect(check()).rejects.toThrow('full commit SHA');
  vi.stubEnv('GITHUB_SHA', sha);
  vi.stubEnv('RAJCORD_RELEASE_TAG', `v${version}-wrong`);
  await expect(check()).rejects.toThrow('exact desktop version');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('rejects a superseded main commit and API permission failures', async () => {
  main = 'b'.repeat(40);
  await expect(check()).rejects.toThrow('superseded');
  fetchMock.mockResolvedValue(new Response('{}', { status: 403 }));
  await expect(check()).rejects.toThrow('403');
});

it('requires a reviewer and explicit refusal of administrator bypass', async () => {
  environment.protection_rules = [];
  await expect(check()).rejects.toThrow('reviewer');
  environment.protection_rules = [{ type: 'required_reviewers', reviewers: [{ id: 1 }] }];
  delete environment.can_admins_bypass;
  await expect(check()).rejects.toThrow('administrator bypass');
  environment.can_admins_bypass = true;
  await expect(check()).rejects.toThrow('administrator bypass');
});

it.each([
  {
    total_count: 2,
    branch_policies: [
      { name: 'main', type: 'branch' },
      { name: 'develop', type: 'branch' },
    ],
  },
  { total_count: 1, branch_policies: [{ name: '*', type: 'branch' }] },
  { total_count: 1, branch_policies: [{ name: 'main', type: 'tag' }] },
])('requires exactly one main branch policy', async (value) => {
  branches = value;
  await expect(check()).rejects.toThrow();
});

it.each([
  { head_sha: 'b'.repeat(40) },
  { head_repository: { full_name: 'other/repo' } },
  { head_branch: 'develop' },
  { event: 'pull_request' },
  { conclusion: 'failure' },
])(
  'requires successful main-push verification of the exact commit and repository',
  async (value) => {
    const valid = (runs.workflow_runs as Record<string, unknown>[])[0];
    runs.workflow_runs = [{ ...valid, ...value }];
    await expect(check()).rejects.toThrow('full Verify workflow');
  },
);
