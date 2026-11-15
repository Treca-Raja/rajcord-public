// Expected failures belong in the feature UI; report unexpected failures at detached call sites.
export function runInBackground(work: PromiseLike<unknown> | undefined): void {
  if (work) void Promise.resolve(work).catch((cause: unknown) => globalThis.reportError(cause));
}
