import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error JavaScript deployment tools are executed directly by Node.
import { checkPolicy, validateProduction, validateRelease } from './ci/policy.mjs';

afterEach(() => vi.unstubAllGlobals());

describe('release boundaries', () => {
  it('rejects mutable image tags and other repositories', () => {
    const sha = 'a'.repeat(40);
    const digest = 'ghcr.io/treca-raja/rajcord-public@sha256:' + 'b'.repeat(64);
    expect(() => validateRelease('Treca-Raja/rajcord-public', sha, digest)).not.toThrow();
    for (const image of [
      'ghcr.io/treca-raja/rajcord-public:main',
      digest + ';echo bad',
      'ghcr.io/other/app@sha256:' + 'b'.repeat(64),
    ])
      expect(() => validateRelease('Treca-Raja/rajcord-public', sha, image)).toThrow();
    expect(() => validateRelease('other/repo', sha, digest)).toThrow();
  });

  it('rejects the predecessor repository and its image under the current repository', () => {
    const sha = 'a'.repeat(40);
    const digest = 'ghcr.io/treca-raja/rajcord-public@sha256:' + 'b'.repeat(64);
    const predecessorImage = 'ghcr.io/fakebane/tricord-public@sha256:' + 'b'.repeat(64);
    expect(() => validateRelease('fakebane/tricord-public', sha, digest)).toThrow(
      'Only the intended repository',
    );
    expect(() => validateRelease('Treca-Raja/rajcord-public', sha, predecessorImage)).toThrow(
      'Use an immutable image digest',
    );
  });

  it('fails closed when production approvals or branch protection are missing', () => {
    const configured = {
      can_admins_bypass: false,
      deployment_branch_policy: { custom_branch_policies: true },
      protection_rules: [{ type: 'required_reviewers', reviewers: [{ id: 1 }] }],
    };
    expect(() => validateProduction(configured)).not.toThrow();
    const restResponse = {
      protection_rules: configured.protection_rules,
      deployment_branch_policy: configured.deployment_branch_policy,
    };
    expect(() => validateProduction(restResponse)).toThrow('administrator bypass');
    for (const value of [
      {},
      { ...configured, protection_rules: [] },
      { ...configured, protection_rules: [{ type: 'required_reviewers', reviewers: [] }] },
      { ...configured, can_admins_bypass: true },
      { ...configured, deployment_branch_policy: null },
    ])
      expect(() => validateProduction(value)).toThrow();
  });

  it('rejects non-main releases before making any GitHub request', async () => {
    await expect(
      checkPolicy('main', {
        GITHUB_REPOSITORY: 'Treca-Raja/rajcord-public',
        GITHUB_SHA: 'a'.repeat(40),
        GITHUB_REF: 'refs/heads/untrusted',
      }),
    ).rejects.toThrow('Only main');
  });

  it('rejects superseded commits and GitHub permission errors', async () => {
    const env = {
      GITHUB_REPOSITORY: 'Treca-Raja/rajcord-public',
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_REF: 'refs/heads/main',
      GH_TOKEN: 'disposable-test',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ object: { sha: 'b'.repeat(40) } }))),
    );
    await expect(checkPolicy('main', env)).rejects.toThrow('superseded');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 403 })),
    );
    await expect(checkPolicy('production', env)).rejects.toThrow('403');
  });

  it('checks exact main-only branch policy after finding the approval rule', async () => {
    const sha = 'a'.repeat(40);
    const env = {
      GITHUB_REPOSITORY: 'Treca-Raja/rajcord-public',
      GITHUB_SHA: sha,
      GITHUB_REF: 'refs/heads/main',
      GH_TOKEN: 'disposable-test',
    };
    const environment = {
      can_admins_bypass: false,
      deployment_branch_policy: { custom_branch_policies: true },
      protection_rules: [{ type: 'required_reviewers', reviewers: [{ id: 1 }] }],
    };
    let branch = 'main';
    const fetch = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('deployment-branch-policies')
              ? { total_count: 1, branch_policies: [{ name: branch, type: 'branch' }] }
              : url.endsWith('/production')
                ? environment
                : { object: { sha } },
          ),
        ),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(checkPolicy('production', env)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/repos/Treca-Raja/rajcord-public/git/ref/heads/main',
      'https://api.github.com/repos/Treca-Raja/rajcord-public/environments/production',
      'https://api.github.com/repos/Treca-Raja/rajcord-public/environments/production/deployment-branch-policies?per_page=100',
    ]);
    branch = '*';
    await expect(checkPolicy('production', env)).rejects.toThrow('Only main');
  });
});
