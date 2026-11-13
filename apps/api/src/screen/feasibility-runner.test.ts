import { describe, expect, it } from 'vitest';
import { runScenario, type Page } from './feasibility-runner.js';

describe('screen feasibility failure cleanup', () => {
  it('rejects video-only capture and disposes both endpoints before negotiation', async () => {
    const calls: string[] = [];
    const page = (role: string): Page => ({
      async js(expression) {
        calls.push(role + ':' + expression);
        if (expression.includes('.capture(')) return ['video'];
        if (expression.includes('.stop('))
          return { tracksEnded: true, peerClosed: true, detached: true };
        throw new Error('Unexpected negotiation after invalid capture');
      },
    });
    await expect(
      runScenario(page('sender'), page('receiver'), {
        mode: 'canvas',
        codec: 'VP8',
        content: 'motion',
        phaseMs: 5000,
      }),
    ).rejects.toThrow('Picture AND source audio tracks required');
    expect(calls.filter((call) => call.includes('.stop('))).toHaveLength(2);
    expect(calls.some((call) => call.includes('.create('))).toBe(false);
  });

  it('reports a cleanup failure even if the original capture failed', async () => {
    const broken: Page = {
      async js(expression) {
        if (expression.includes('.capture(')) throw new Error('Capture denied');
        return { tracksEnded: false, peerClosed: true, detached: true };
      },
    };
    await expect(
      runScenario(broken, broken, {
        mode: 'canvas',
        codec: 'VP8',
        content: 'motion',
        phaseMs: 5000,
      }),
    ).rejects.toThrow('must be disposed');
  });
});
