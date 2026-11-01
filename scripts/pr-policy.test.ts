import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error JavaScript policy is executed directly by Node in CI.
import { checkPullRequest, validatePullRequest } from './ci/pr-policy.mjs';

const repository = 'Treca-Raja/rajcord-public';
function pullRequest(base: string, head: string, source = repository) {
  return {
    base: { ref: base, repo: { full_name: repository } },
    head: { ref: head, repo: { full_name: source } },
  };
}

describe('PR delivery path', () => {
  it('allows feature and dependency updates into develop, including fork contributions', () => {
    for (const source of [repository, 'contributor/rajcord-public'])
      for (const head of ['feature/ci-cd-completion', 'dependabot/npm_and_yarn/update'])
        expect(() => validatePullRequest(pullRequest('develop', head, source))).not.toThrow();
  });

  it('allows only the same repository develop branch into main', () => {
    expect(() => validatePullRequest(pullRequest('main', 'develop'))).not.toThrow();
    expect(() =>
      validatePullRequest(pullRequest('main', 'develop', 'treca-raja/rajcord-public')),
    ).not.toThrow();
    expect(() =>
      validatePullRequest(pullRequest('main', 'develop', 'contributor/rajcord-public')),
    ).toThrow('same repository');
    for (const head of ['feature/example', 'dependabot/npm_and_yarn/update', 'main'])
      expect(() => validatePullRequest(pullRequest('main', head))).toThrow('develop to main');
  });

  it('rejects unsupported targets, reverse promotion and unscoped feature branches', () => {
    for (const [base, head] of [
      ['other', 'feature/example'],
      ['develop', 'main'],
      ['develop', 'develop'],
      ['develop', 'fix/example'],
      ['develop', 'feature/'],
    ])
      expect(() => validatePullRequest(pullRequest(base, head))).toThrow();
  });

  it('fails closed on missing or deleted PR repository data', () => {
    for (const pr of [undefined, {}, { base: {} }, { ...pullRequest('main', 'develop'), head: {} }])
      expect(() => validatePullRequest(pr)).toThrow('repository data');
  });

  it('reads the GitHub event file for PRs and leaves push/manual release policy unchanged', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'rajcord-pr-policy-'));
    const eventPath = path.join(directory, 'event.json');
    try {
      for (const event of ['push', 'workflow_dispatch'])
        expect(() => checkPullRequest({ GITHUB_EVENT_NAME: event })).not.toThrow();
      const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath };
      writeFileSync(
        eventPath,
        JSON.stringify({ pull_request: pullRequest('develop', 'feature/test') }),
      );
      expect(() => checkPullRequest(env)).not.toThrow();
      writeFileSync(
        eventPath,
        JSON.stringify({ pull_request: pullRequest('main', 'feature/test') }),
      );
      expect(() => checkPullRequest(env)).toThrow('develop to main');
      writeFileSync(eventPath, '{}');
      expect(() => checkPullRequest(env)).toThrow('repository data');
      writeFileSync(eventPath, 'invalid-json');
      expect(() => checkPullRequest(env)).toThrow(SyntaxError);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
