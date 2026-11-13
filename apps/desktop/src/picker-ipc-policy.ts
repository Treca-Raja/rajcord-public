import type { CaptureDocument } from './screen-capture-policy.js';

export function trustedPickerCaller(
  expected: CaptureDocument,
  current: CaptureDocument | null,
  sender: object,
  frame: object | null,
) {
  return (
    !!current?.alive &&
    sender === expected.webContents &&
    frame === expected.mainFrame &&
    current.webContents === expected.webContents &&
    current.mainFrame === expected.mainFrame &&
    current.url === expected.url &&
    current.navigation === expected.navigation
  );
}
export class PickerIpcBudget {
  private tokens = 12;
  private updated: number;
  private pending = 0;
  constructor(private now: () => number = Date.now) {
    this.updated = now();
  }
  acquire(): (() => void) | null {
    const time = this.now();
    this.tokens = Math.min(12, this.tokens + Math.max(0, time - this.updated) / 1000);
    this.updated = time;
    if (this.tokens < 1 || this.pending >= 2) return null;
    this.tokens--;
    this.pending++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.pending--;
      }
    };
  }
}
