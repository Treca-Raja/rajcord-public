import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = (name: string) =>
  readFileSync(new URL('../.github/workflows/' + name, import.meta.url), 'utf8');
const ci = workflow('ci.yml');
const release = workflow('verify.yml');
const desktop = workflow('desktop.yml');
const prPolicy = workflow('pr-policy.yml');

function job(text: string, name: string) {
  const match = text.match(
    new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [A-Za-z][\\w-]*:\\n|(?![\\s\\S]))`, 'm'),
  );
  if (!match) throw new Error('Missing workflow job: ' + name);
  return match[0].trimEnd();
}
function triggers(text: string) {
  const match = text.match(/^on:\n([\s\S]*?)^(?=\S)/m);
  if (!match) throw new Error('Missing workflow triggers');
  return match[1]!;
}
const withoutSteps = (block: string, titles: string[]) =>
  block
    .split(/\n(?= {6}- )/)
    .filter((step) => !titles.some((title) => step.startsWith('      - name: ' + title)))
    .join('\n');

describe('informational pull-request checks', () => {
  it('runs verification once per commit: PRs and develop use ci.yml, main uses the release workflow', () => {
    expect(triggers(ci)).toContain('pull_request:\n    types: [opened, synchronize, reopened]');
    expect(triggers(ci)).toContain('push:\n    branches: [develop]');
    expect(triggers(ci)).not.toContain('workflow_dispatch');
    expect(triggers(release)).toContain('push:\n    branches: [main]');
    expect(triggers(release)).not.toContain('pull_request');
    expect(triggers(release)).toContain('workflow_dispatch');
  });

  it('keeps every release-only capability out of the pull-request workflows', () => {
    for (const text of [ci, prPolicy, desktop.split('\n  release-policy:')[0]!]) {
      expect(text).not.toMatch(/publish_only|environment:|packages: write|HOSTING_ENABLED/);
      expect(text).not.toContain('docker push');
    }
    expect(release).toContain('environment: production');
    for (const name of ['publish', 'production-policy', 'production'])
      expect(job(release, name)).toBeTruthy();
    for (const name of ['publish', 'production-policy', 'production'])
      expect(() => job(ci, name)).toThrow('Missing workflow job');
  });

  it('still requires a successful verification in the same run before publishing or deploying', () => {
    const publish = job(release, 'publish');
    expect(publish).toContain('needs: verify');
    expect(publish).toContain("github.ref == 'refs/heads/main'");
    expect(publish).toContain("vars.HOSTING_ENABLED == 'true' || inputs.publish_only == true");
    expect(publish).toContain('node scripts/ci/policy.mjs main');
    const policy = job(release, 'production-policy');
    expect(policy).toContain('needs: publish');
    expect(policy).toContain("vars.HOSTING_ENABLED == 'true' && inputs.publish_only != true");
    const production = job(release, 'production');
    expect(production).toContain('needs: [publish, production-policy]');
    expect(production).toContain('environment: production');
    expect(production).toContain("vars.HOSTING_ENABLED == 'true' && inputs.publish_only != true");
    // The tested image is saved by the same verify job that must pass before publication.
    const verify = job(release, 'verify');
    expect(verify).toContain('docker save tricord-ci');
    expect(verify).toContain('name: tested-image');
  });

  it('prevents the two verification jobs from drifting apart', () => {
    const releaseVerification = withoutSteps(job(release, 'verify'), [
      'Save the tested image for publication',
      'Upload the exact tested image',
    ]);
    expect(releaseVerification).toBe(job(ci, 'verify'));
  });

  it('checks the PR source and base in a separate cheap workflow, including retargeting', () => {
    expect(triggers(prPolicy)).toContain('types: [opened, synchronize, reopened, edited]');
    expect(prPolicy).toContain('run: node scripts/ci/pr-policy.mjs');
    expect(job(prPolicy, 'policy')).not.toContain('pnpm');
    expect(release).not.toContain('pr-policy.mjs');
    expect(ci).not.toContain('pr-policy.mjs');
  });

  it('limits the Windows PR check to relevant paths without weakening manual releases', () => {
    const pullRequest = triggers(desktop).match(/pull_request:\n([\s\S]*?)\n {2}push:/)?.[1] ?? '';
    for (const path of ['apps/desktop/**', 'apps/web/**', 'packages/**', 'pnpm-lock.yaml'])
      expect(pullRequest).toContain('- ' + path);
    expect(triggers(desktop)).toContain('push:\n    branches: [develop, main]');
    for (const command of ['pnpm format:check', 'pnpm lint', 'pnpm typecheck', 'pnpm test'])
      expect(desktop).toContain(
        `      - if: github.event_name != 'pull_request'\n        run: ${command}\n`,
      );
    for (const command of ['pnpm build', 'pnpm desktop:package', 'node scripts/desktop-audit.mjs'])
      expect(job(desktop, 'build')).toContain(command);
    expect(job(desktop, 'draft')).toContain('environment: desktop-release');
    expect(job(desktop, 'release-policy')).toContain('inputs.publish_draft == true');
  });
});
