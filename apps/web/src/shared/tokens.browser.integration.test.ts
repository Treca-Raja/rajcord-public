import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { launch } from '../../../api/src/voice/browser-harness';

type Palette = Record<string, number>;

function contrast(a: number, b: number) {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

it('keeps workspace text and keyboard focus legible across interactive surfaces', async () => {
  const styles = await Promise.all(
    ['./tokens.css', '../features/appearance/styles.css'].map((path) =>
      readFile(new URL(path, import.meta.url), 'utf8'),
    ),
  );
  const browser = await launch({ fakeMicrophone: false });
  try {
    await browser.js(
      `document.head.appendChild(document.createElement('style')).textContent=${JSON.stringify(styles.join('\n'))}`,
    );
    for (const [theme, region] of [
      ['original', 'chat'],
      ['original', 'sidebar'],
      ['retro', 'chat'],
      ['retro', 'sidebar'],
    ]) {
      const palette = (await browser.js(`(()=>{
        document.documentElement.dataset.appearance=${JSON.stringify(theme)};
        document.body.className=${JSON.stringify(region)};
        const sample=document.createElement('span');
        document.body.replaceChildren(sample);
        const context=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
        const tokens=['surface-chat','surface-sidebar','surface-inset','surface-raised','surface-selected','surface-hover',
          'text-primary','text-secondary','text-muted','accent-brand','accent-media','accent-voice','text-on-accent','warning','error','focus','line-strong'];
        return Object.fromEntries(tokens.map(token=>{
          sample.style.color='var(--'+token+')';
          context.fillStyle=getComputedStyle(sample).color;
          context.fillRect(0,0,1,1);
          const linear=Array.from(context.getImageData(0,0,1,1).data).slice(0,3).map(channel=>{
            const value=channel/255;
            return value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4;
          });
          return [token,linear[0]*0.2126+linear[1]*0.7152+linear[2]*0.0722];
        }));
      })()`)) as Palette;
      for (const surface of [region, 'inset', 'raised', 'selected', 'hover']) {
        const background = palette['surface-' + surface]!;
        for (const token of [
          'text-primary',
          'text-secondary',
          'text-muted',
          'accent-brand',
          'accent-media',
          'accent-voice',
          'warning',
          'error',
          'focus',
          'line-strong',
        ]) {
          expect(
            contrast(palette[token]!, background),
            [theme, region, surface, token].join(' / '),
          ).toBeGreaterThanOrEqual(['focus', 'line-strong'].includes(token) ? 3 : 4.5);
        }
      }
      expect(contrast(palette['text-on-accent']!, palette['accent-brand']!)).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  } finally {
    await browser.close();
  }
});
