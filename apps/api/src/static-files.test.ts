import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import staticFiles from '@fastify/static';
import { afterEach, describe, expect, it } from 'vitest';

const fixtures: { app: FastifyInstance; directory: string }[] = [];
const script = 'console.log("static fixture");';
const outside = 'test-only content outside the public directory';

afterEach(async () => {
  for (const { app, directory } of fixtures.splice(0)) {
    await app.close();
    if (
      path.dirname(directory) !== path.resolve(tmpdir()) ||
      !path.basename(directory).startsWith('rajcord-static-')
    )
      throw new Error('Refusing unexpected static fixture cleanup.');
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(mode: 'default' | 'enumerated') {
  const directory = await mkdtemp(path.join(tmpdir(), 'rajcord-static-'));
  const root = path.join(directory, 'public');
  const app = Fastify();
  fixtures.push({ app, directory });
  await mkdir(path.join(root, 'assets', 'js'), { recursive: true });
  await mkdir(path.join(root, 'assets', 'private'), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, 'index.html'), '<p>Static fixture</p>'),
    writeFile(path.join(root, 'assets', 'js', 'app.js'), script),
    writeFile(path.join(root, 'assets', 'private', 'internal.js'), 'test-only excluded asset'),
    writeFile(path.join(root, '.hidden-config'), 'test-only hidden content'),
    writeFile(path.join(directory, 'outside.txt'), outside),
  ]);
  await app.register(staticFiles, {
    root,
    dotfiles: 'ignore',
    ...(mode === 'enumerated' ? { wildcard: false, globIgnore: ['assets/private/**'] } : {}),
  });
  await app.ready();
  return app;
}

describe.each(['default', 'enumerated'] as const)('static serving with %s routes', (mode) => {
  it('serves the index and nested assets with GET and HEAD', async () => {
    const app = await fixture(mode);
    const index = await app.inject('/');
    expect(index.statusCode).toBe(200);
    expect(index.body).toBe('<p>Static fixture</p>');
    const asset = await app.inject('/assets/js/app.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe(script);
    expect(asset.headers['content-type']).toMatch(/javascript/);
    const head = await app.inject({ method: 'HEAD', url: '/assets/js/app.js' });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe(String(Buffer.byteLength(script)));
  });

  it('returns not found for missing assets and explicitly ignored hidden files', async () => {
    const app = await fixture(mode);
    expect((await app.inject('/assets/js/missing.js')).statusCode).toBe(404);
    const hidden = await app.inject('/.hidden-config');
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).not.toContain('test-only hidden content');
  });

  it('does not serve files outside the configured public directory', async () => {
    const app = await fixture(mode);
    for (const url of ['/%2e%2e/outside.txt', '/%2e%2e%2foutside.txt']) {
      const response = await app.inject(url);
      expect([400, 403, 404]).toContain(response.statusCode);
      expect(response.body).not.toContain(outside);
    }
  });
});

it('honors globIgnore when building explicit routes from the static root', async () => {
  const app = await fixture('enumerated');
  expect((await app.inject('/assets/private/internal.js')).statusCode).toBe(404);
  expect((await app.inject('/assets/js/app.js')).body).toBe(script);
});
