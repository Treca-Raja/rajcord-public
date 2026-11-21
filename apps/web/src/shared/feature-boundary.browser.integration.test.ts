import { expect, it } from 'vitest';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { launch, type Browser } from '../../../api/src/voice/browser-harness';

it('isolates rendering failures, preserves sibling drafts and invokes media owners on failure', async () => {
  const web = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../..', import.meta.url)),
    server: { host: '127.0.0.1', port: 3014, strictPort: true },
    plugins: [
      {
        name: 'owned-error-boundary-fixture',
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url !== '/fixture') return next();
            response.setHeader('Content-Type', 'text/html');
            response.setHeader(
              'Permissions-Policy',
              'microphone=(), camera=(), display-capture=()',
            );
            response.end(
              '<!doctype html><title>Owned recovery fixture</title><div id="root"></div><script type="module" src="/src/shared/feature-boundary-fixture.integration.tsx"></script>',
            );
          });
        },
      },
    ],
  });
  let browser: Browser | undefined;
  try {
    await web.listen();
    browser = await launch({ fakeMicrophone: false });
    await browser.call('Page.navigate', { url: 'http://127.0.0.1:3014/fixture' });
    await browser.wait('document.body?.textContent.includes("Settings fixture ready")');
    await browser.js(
      'window.ownedDraft = document.querySelector("input"); window.featureFixture.fault = true; window.featureFixture.render();',
    );
    await browser.wait(
      'document.querySelector("[role=alert]")?.textContent.includes("Account settings")',
    );
    expect(await browser.js('window.featureFixture.cleanups')).toBe(1);
    expect(
      await browser.js(
        'window.ownedDraft === document.querySelector("input") && window.ownedDraft.value === "Keep this draft"',
      ),
    ).toBe(true);
    await browser.js('window.featureFixture.fault = false');
    await browser.click('Retry');
    await browser.wait('document.body?.textContent.includes("Settings fixture ready")');

    await browser.js('window.featureFixture.mode="screen"; window.featureFixture.render();');
    await browser.wait(
      '!document.querySelector("[role=alert]") && !document.body?.textContent.includes("Settings fixture ready")',
    );
    await browser.js('window.featureFixture.fault=true; window.featureFixture.render();');
    await browser.wait(`!!document.querySelector('[aria-label="Screen sharing unavailable"]')`);
    expect(
      await browser.js(
        '[window.featureFixture.sourceStops, window.featureFixture.watchStops, window.featureFixture.leaves]',
      ),
    ).toEqual([1, 1, 0]);
    await browser.call('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const artifacts = fileURLToPath(new URL('../../../../artifacts/', import.meta.url));
    await mkdir(artifacts, { recursive: true });
    const screenshot = await browser.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      artifacts + 'feature-recovery-mobile.png',
      Buffer.from(screenshot.data as string, 'base64'),
    );
    await browser.js('window.featureFixture.fault=false');
    await browser.click('Retry');
    await browser.wait('!document.querySelector("[role=alert]")');
    expect(
      await browser.js(
        '[window.featureFixture.sourceStops, window.featureFixture.watchStops, window.featureFixture.leaves]',
      ),
    ).toEqual([1, 1, 0]);

    await browser.js('window.featureFixture.mode="voice"; window.featureFixture.render();');
    await browser.wait('!!document.querySelector(".voice-panel")');
    await browser.js('window.featureFixture.fault=true; window.featureFixture.render();');
    await browser.wait(`!!document.querySelector('[aria-label="Voice chat unavailable"]')`);
    expect(await browser.js('window.featureFixture.leaves')).toBe(1);
    expect(await browser.js('document.querySelector("input").value')).toBe('Keep this draft');
    expect(await browser.js('document.body?.textContent.includes("Synthetic")')).toBe(false);
    await browser.js(`window.fetch = async () => Response.json({csrfToken: 'private-fixture'});
      window.featureFixture.mode='auth'; window.featureFixture.render();`);
    await browser.wait(
      'document.querySelector("[role=alert]")?.textContent.includes("Could not check your account")',
    );
    expect(
      await browser.js('document.body.textContent.includes("Protected fixture content")'),
    ).toBe(false);
    expect(await browser.js('document.body.textContent.includes("private-fixture")')).toBe(false);
  } finally {
    await browser?.close();
    await web.close();
  }
}, 60_000);
