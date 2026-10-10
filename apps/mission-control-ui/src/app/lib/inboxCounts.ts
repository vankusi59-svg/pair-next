/* P15.9-B4 R1-F1 — shared invalidation for inbox counts.
   Any successful inbox mutation (approve/deny, later A2 routes) bumps
   every subscriber so the Inbox page AND the AppShell badge both
   refetch canonical state — never an optimistic local decrement. */

type Listener = () => void;
const listeners = new Set<Listener>();

export function onInboxInvalidate(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function invalidateInboxCounts(): void {
  for (const fn of [...listeners]) fn();
}
