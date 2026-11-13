import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = (name: string) =>
  readFileSync(new URL('../.github/workflows/' + name, import.meta.url), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
const verification = workflow('verify.yml');
const delivery = workflow('delivery.yml');
const desktop = workflow('desktop.yml');
function triggers(text: string) {
  const match = text.match(/^on:\n([\s\S]*?)^permissions:/m);
  if (!match) throw new Error('Missing workflow triggers');
  return match[1]!;
}
function job(text: string, name: string) {
  const match = text.match(
    new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [A-Za-z][\\w-]*:\\n|(?![\\s\\S]))`, 'm'),
  );
  if (!match) throw new Error('Missing workflow job: ' + name);
  return match[0];
}

describe('verification and delivery boundaries', () => {
  it('avoids duplicate feature push and PR verification while retaining retarget checks', () => {
    expect(triggers(verification)).toContain('push:\n    branches: [develop]');
    expect(triggers(verification)).not.toContain('branches-ignore');
    expect(triggers(verification)).toContain('types: [opened, synchronize, reopened, edited]');
    expect(verification).toContain('run: node scripts/ci/pr-policy.mjs');
    expect(triggers(delivery)).toContain('push:\n    branches: [main]');
    expect(triggers(delivery)).not.toContain('pull_request');
  });
  it('keeps publication and production secrets out of PR verification', () => {
    expect(verification).not.toMatch(/packages: write|environment: production|docker push/);
    for (const name of ['publish', 'production-policy', 'production'])
      expect(() => job(verification, name)).toThrow('Missing workflow job');
    expect(verification).toContain(
      "if: inputs.prepare_release == true && github.ref == 'refs/heads/main'",
    );
  });
  it('publishes only after the same main run has produced its tested image', () => {
    expect(job(delivery, 'verify')).toContain('uses: ./.github/workflows/verify.yml');
    const publish = job(delivery, 'publish');
    expect(publish).toContain('needs: verify');
    expect(publish).toContain("github.ref == 'refs/heads/main'");
    expect(publish).toContain('node scripts/ci/policy.mjs main');
    expect(publish).toContain('name: tested-image');
    expect(job(verification, 'verify')).toContain('docker save tricord-ci');
    expect(job(delivery, 'production-policy')).toContain('needs: publish');
    expect(job(delivery, 'production')).toContain('needs: [publish, production-policy]');
    expect(job(delivery, 'production')).toContain('environment: production');
  });
  it('retains unconditional Windows startup tests and packaging on PRs', () => {
    expect(triggers(desktop)).toContain('pull_request:');
    expect(triggers(desktop)).not.toContain('paths:');
    const build = job(desktop, 'build');
    for (const command of [
      'pnpm format:check',
      'pnpm lint',
      'pnpm typecheck',
      'pnpm test',
      'pnpm build',
      'pnpm desktop:package',
    ])
      expect(build).toContain('      - run: ' + command + '\n');
    expect(build).not.toContain("github.event_name != 'pull_request'");
    expect(job(desktop, 'draft')).toContain('environment: desktop-release');
  });
});
