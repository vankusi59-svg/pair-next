// §4.1 — shared SSE bus. One EventSource for the app; consumers subscribe to
// canonical entity events. Buffers the last N events for the observability
// stream and notifies subscribers so pages can reload their projections.
import { useEffect, useRef, useState } from "react";
import { withTokenQuery } from "../api";

export interface EntityEvent {
  seq?: number;
  event_id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  new_state?: string | null;
  actor?: string | null;
  created_at?: string;
}

const BUFFER = 300;
const recent: EntityEvent[] = [];
const listeners = new Set<(e: EntityEvent) => void>();
const resyncListeners = new Set<() => void>();
/* B5.5 R1-F3 — stream status is a SUBSCRIPTION SET, not a single mutable
   callback: every mounted consumer observes the same status, and an
   unmounted subscriber stops receiving updates. */
const statusListeners = new Set<(s: "open" | "closed") => void>();
const bufferListeners = new Set<() => void>();
let es: EventSource | null = null;
let status: "open" | "closed" = "closed";

const setStatus = (s: "open" | "closed") => {
  status = s;
  for (const l of statusListeners) l(s);
};
const notifyBuffer = () => {
  for (const l of bufferListeners) l();
};

function ensure() {
  if (es) return;
  es = new EventSource(withTokenQuery("/api/events"));
  es.onopen = () => setStatus("open");
  es.onerror = () => setStatus("closed"); // EventSource auto-reconnects; UI keeps slow polling
  es.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data as string) as EntityEvent;
      recent.push(e);
      if (recent.length > BUFFER) recent.splice(0, recent.length - BUFFER);
      for (const l of listeners) l(e);
      notifyBuffer();
    } catch {
      /* malformed frame — ignore */
    }
  };
  es.addEventListener("resync", () => {
    for (const l of resyncListeners) l();
  });
}

export function recentEvents(): EntityEvent[] {
  return recent;
}

export function streamStatus(): "open" | "closed" {
  return status;
}

/* P15.9-B5.5 Settings E5 / R1-F3 — reconnect the shared stream after a
   credential change so the token-query URL picks up the new token.
   Events buffered under the PREVIOUS credential are cleared first —
   they were authenticated under a different identity and are never
   presented as current data under the new one. Buffer subscribers and
   resync listeners are both notified so rendered streams empty and
   live-refreshed projections refetch under the new credential. Same
   single canonical EventSource; no new SSE backend. */
export function reconnectStream() {
  if (es) {
    es.close();
    es = null;
  }
  recent.length = 0;
  notifyBuffer();
  for (const l of resyncListeners) l();
  setStatus("closed");
  ensure();
}

/* Subscribe to stream status. The listener fires immediately with the
   current status so a late-mounting consumer converges, then on every
   transition. Returns the unsubscribe function — an unmounted
   subscriber stops receiving updates. */
export function onStreamStatus(cb: (s: "open" | "closed") => void): () => void {
  ensure();
  statusListeners.add(cb);
  cb(status);
  return () => {
    statusListeners.delete(cb);
  };
}

/* Buffer-change notifications: fired on every appended event AND when
   the buffer is cleared by a credential reconnect, so the rendered
   stream view always reflects the buffer of the CURRENT credential. */
export function subscribeBuffer(cb: () => void): () => void {
  ensure();
  bufferListeners.add(cb);
  return () => {
    bufferListeners.delete(cb);
  };
}

export function subscribeEvents(cb: (e: EntityEvent) => void): () => void {
  ensure();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function subscribeResync(cb: () => void): () => void {
  ensure();
  resyncListeners.add(cb);
  return () => resyncListeners.delete(cb);
}

/** Reload `fn` on any canonical event (debounced). Fallback polling stays on
 *  the caller's useApi poll — SSE is the fast path, not the only path. */
export function useLiveRefresh(reload: () => void) {
  const ref = useRef(reload);
  ref.current = reload;
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (t) return;
      t = setTimeout(() => {
        t = null;
        ref.current();
      }, 150);
    };
    const u1 = subscribeEvents(bump);
    const u2 = subscribeResync(bump);
    return () => {
      u1();
      u2();
      if (t) clearTimeout(t);
    };
  }, []);
}

/** Rolling event buffer for the observability stream view. Re-renders
 *  on appends AND on credential-change clears — never keeps showing
 *  events authenticated under a previous token as current data. */
export function useEventBuffer(entityTypes?: string[]) {
  const [events, setEvents] = useState<EntityEvent[]>(() => recent);
  useEffect(() => {
    const cb = () => setEvents([...recent]);
    const u = subscribeBuffer(cb);
    cb();
    return u;
  }, []);
  return entityTypes?.length
    ? events.filter((e) => entityTypes.includes(e.entity_type))
    : events;
}
