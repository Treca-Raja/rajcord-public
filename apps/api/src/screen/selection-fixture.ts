import type { ScreenLinkGrant, ScreenSelectRequest } from '@tricord/shared';

type Operation = Readonly<{
  request: Readonly<ScreenSelectRequest>;
  run(): Promise<ScreenLinkGrant | null>;
}>;
type Selection = Readonly<{
  operation: Operation;
  reserveCleanup(): Operation | null;
}>;

// Test-only request planning: a reservation sends nothing and confers no authority.
export function selectionFixture(
  epoch: string,
  send: (request: Readonly<ScreenSelectRequest>) => Promise<ScreenLinkGrant | null>,
) {
  let revision = 0,
    current: Selection | undefined;
  const operation = (shareId: string | null): Operation => {
    const request = Object.freeze({
      epoch,
      requestId: crypto.randomUUID(),
      revision: ++revision,
      shareId,
      profile: 'smooth' as const,
      videoBitrate: 4000000 as const,
    });
    return Object.freeze({ request, run: () => send(request) });
  };
  return Object.freeze({
    select(shareId: string): Selection {
      current?.reserveCleanup();
      let cleanup: Operation | undefined;
      const selected: Selection = Object.freeze({
        operation: operation(shareId),
        reserveCleanup() {
          if (current !== selected) return null;
          return (cleanup ??= operation(null));
        },
      });
      current = selected;
      return selected;
    },
  });
}
