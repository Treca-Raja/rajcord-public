// Coalesce simultaneous mount/focus/socket refreshes without caching stale authorization.
export function singleFlight<T>(work: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= work().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
