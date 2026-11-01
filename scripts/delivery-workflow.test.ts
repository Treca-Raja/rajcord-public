import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type Step = {
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  'continue-on-error'?: boolean;
};
type Job = {
  uses?: string;
  if?: string;
  needs?: string | string[];
  with?: Record<string, unknown>;
  secrets?: unknown;
  environment?: string | { name: string };
  permissions?: Record<string, string>;
  steps?: Step[];
  'continue-on-error'?: boolean;
};
type Workflow = {
  on: Record<string, { inputs?: Record<string, unknown>; branches?: string[] } | null>;
  permissions: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': boolean | string };
  jobs: Record<string, Job>;
};

const requireDesktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { load } = requireDesktop('js-yaml') as { load: (contents: string) => unknown };
function workflow(name: string) {
  return load(
    readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'),
  ) as Workflow;
}
const verify = workflow('verify');
const delivery = workflow('delivery');
function job(source: Workflow, name: string): Job {
  const value = source.jobs[name];
  if (!value) throw new Error('Missing workflow job: ' + name);
  return value;
}
const verification = job(verify, 'verify');
const mainVerification = job(delivery, 'verify');
const runs = (job: Job) => (job.steps ?? []).map((step) => step.run ?? '').join('\n');
const dependencies = (job: Job) =>
  typeof job.needs === 'string' ? [job.needs] : (job.needs ?? []);
function allows(
  expression: unknown,
  event: string,
  ref: string,
  hosting = false,
  publishOnly = false,
  prepareRelease = false,
) {
  if (expression === undefined) return true;
  if (typeof expression === 'boolean') return expression;
  expect(typeof expression).toBe('string');
  // These conditions use boolean/comparison operators shared by Actions and JavaScript.
  return Boolean(
    runInNewContext(
      (expression as string).replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, ''),
      {
        github: { event_name: event, ref },
        vars: { HOSTING_ENABLED: hosting ? 'true' : 'false' },
        inputs: { publish_only: publishOnly, prepare_release: prepareRelease },
      },
      { timeout: 100 },
    ),
  );
}

describe('verification and main-only delivery boundary', () => {
  it('keeps PR verification separate from the main-only delivery entry points', () => {
    expect(Object.keys(delivery.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(delivery.on.push?.branches).toEqual(['main']);
    expect(Object.keys(verify.on).sort()).toEqual([
      'pull_request',
      'push',
      'workflow_call',
      'workflow_dispatch',
    ]);
    expect(verify.on.push).toMatchObject({ 'branches-ignore': ['main'] });
    expect(verify.on.pull_request).toMatchObject({ types: expect.arrayContaining(['edited']) });
    expect(delivery.on.workflow_dispatch?.inputs?.publish_only).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(verify.on.workflow_dispatch?.inputs).toBeUndefined();
    expect(verify.on.workflow_call?.inputs?.prepare_release).toMatchObject({
      type: 'boolean',
      default: false,
    });
  });

  it('retains one Linux verifier without the added browser or Windows jobs', () => {
    expect(Object.keys(verify.jobs)).toEqual(['verify']);
    const checks = runs(verification);
    for (const command of ['pnpm test', 'pnpm test:db', 'pnpm build'])
      expect(checks).toContain(command);
    expect(checks).toContain('scripts/server-image-smoke.mjs tricord-ci');
    expect(checks).toContain('scripts/hosting/smoke.mjs tricord-ci');
    expect(checks).not.toMatch(/test:browser|google-chrome|TRICORD_BROWSER_PATH/);
    expect(verify.permissions).toEqual({ contents: 'read' });
    expect(JSON.stringify(verify)).not.toMatch(/packages.*write|DEPLOY_SSH_KEY|secrets\./);
    expect(verification['continue-on-error']).not.toBe(true);
  });

  it('verifies current main even when production delivery is disabled', () => {
    const job = mainVerification;
    expect(job.uses).toBe('./.github/workflows/verify.yml');
    expect(job.secrets).toBeUndefined();
    expect(allows(job.if, 'push', 'refs/heads/main', false)).toBe(true);
    expect(allows(job.if, 'workflow_dispatch', 'refs/heads/main', false, false)).toBe(true);
    for (const ref of ['refs/heads/develop', 'refs/heads/feature/test', 'refs/pull/22/merge'])
      expect(allows(job.if, 'workflow_dispatch', ref, true, true)).toBe(false);
  });

  it('prepares and publishes only enabled main pushes or explicit main publish-only dispatches', () => {
    const prepare = mainVerification.with?.prepare_release;
    const publish = job(delivery, 'publish');
    expect(dependencies(publish)).toContain('verify');
    expect(publish['continue-on-error']).not.toBe(true);
    for (const event of ['push', 'pull_request', 'workflow_dispatch'])
      for (const ref of ['refs/heads/main', 'refs/heads/develop', 'refs/pull/22/merge'])
        for (const hosting of [false, true])
          for (const publishOnly of [false, true]) {
            const expected =
              ref === 'refs/heads/main' &&
              ((event === 'push' && hosting) || (event === 'workflow_dispatch' && publishOnly));
            const prepared = allows(prepare, event, ref, hosting, publishOnly);
            const callerRuns = allows(mainVerification.if, event, ref, hosting, publishOnly);
            expect(prepared && callerRuns, `${event}/${ref}/${hosting}/${publishOnly}`).toBe(
              expected,
            );
            expect(allows(publish.if, event, ref, hosting, publishOnly)).toBe(expected);
          }
  });

  it('uploads only the built and tested main image requested by the delivery caller', () => {
    const steps = verification.steps ?? [];
    const save = steps.find((step) => step.run?.includes('docker save tricord-ci'));
    const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(save).toBeDefined();
    expect(upload).toBeDefined();
    const imageCheck = steps.findIndex((step) =>
      step.run?.includes('scripts/server-image-smoke.mjs tricord-ci'),
    );
    const hostedCheck = steps.findIndex((step) =>
      step.run?.includes('scripts/hosting/smoke.mjs tricord-ci'),
    );
    expect(imageCheck).toBeGreaterThan(-1);
    expect(hostedCheck).toBeGreaterThan(-1);
    for (const index of [imageCheck, hostedCheck]) {
      expect(steps[index]!.if).toBeUndefined();
      expect(steps[index]!['continue-on-error']).not.toBe(true);
    }
    expect(steps.indexOf(save!)).toBeGreaterThan(Math.max(imageCheck, hostedCheck));
    for (const step of [save!, upload!])
      for (const ref of ['refs/heads/main', 'refs/heads/develop', 'refs/pull/22/merge'])
        for (const prepareRelease of [false, true])
          expect(allows(step.if, 'push', ref, true, false, prepareRelease)).toBe(
            prepareRelease && ref === 'refs/heads/main',
          );
    expect(upload!.with).toMatchObject({
      name: 'tested-image',
      path: 'artifacts/tricord-image.tar.gz',
      'if-no-files-found': 'error',
    });
  });

  it('publishes the same-run image after checking its revision and current-main policy', () => {
    const publish = job(delivery, 'publish');
    const download = publish.steps?.find((step) =>
      step.uses?.startsWith('actions/download-artifact@'),
    );
    expect(download?.with).toMatchObject({ name: 'tested-image', path: 'artifacts' });
    expect(download?.with).not.toHaveProperty('run-id');
    expect(download?.with).not.toHaveProperty('repository');
    expect(download?.with).not.toHaveProperty('github-token');
    expect(publish.permissions?.packages).toBe('write');
    const commands = runs(publish);
    expect(commands).toContain('scripts/ci/policy.mjs main');
    expect(commands).toContain('gzip -dc artifacts/tricord-image.tar.gz | docker load');
    expect(commands).toMatch(/test .*org\.opencontainers\.image\.revision.*=.*"\$GITHUB_SHA"/);
    expect(commands).toContain('ghcr.io/treca-raja/rajcord-public:$GITHUB_SHA');
    expect(commands).toContain('TRICORD_IMAGE="$image" node scripts/ci/policy.mjs main');
    expect(commands).not.toContain('docker build');
  });

  it('never deploys from PRs, non-main refs, disabled hosting or manual dispatches', () => {
    for (const name of ['production-policy', 'production'])
      for (const event of ['push', 'pull_request', 'workflow_dispatch'])
        for (const ref of ['refs/heads/main', 'refs/heads/develop', 'refs/pull/22/merge'])
          for (const hosting of [false, true])
            for (const publishOnly of [false, true])
              expect(allows(job(delivery, name).if, event, ref, hosting, publishOnly)).toBe(
                event === 'push' && ref === 'refs/heads/main' && hosting && !publishOnly,
              );
  });

  it('keeps production approval, immutable-image handoff and serialized deployments', () => {
    const policy = job(delivery, 'production-policy');
    const production = job(delivery, 'production');
    expect(dependencies(policy)).toContain('publish');
    expect(runs(policy)).toContain('node scripts/ci/policy.mjs production');
    expect(dependencies(production)).toEqual(
      expect.arrayContaining(['publish', 'production-policy']),
    );
    expect(
      typeof production.environment === 'string'
        ? production.environment
        : production.environment?.name,
    ).toBe('production');
    expect(runs(production)).toContain('node scripts/ci/deploy.mjs production');
    const deploy = production.steps?.find((step) =>
      step.run?.includes('node scripts/ci/deploy.mjs production'),
    );
    expect(deploy?.env?.TRICORD_IMAGE).toMatch(/^\$\{\{\s*needs\.publish\.outputs\.image\s*\}\}$/);
    expect(production.permissions?.packages).not.toBe('write');
    expect(delivery.concurrency['cancel-in-progress']).toBe(false);
    expect(delivery.concurrency.group).not.toMatch(/run_id|run_number|sha|event_name/);
  });
});
