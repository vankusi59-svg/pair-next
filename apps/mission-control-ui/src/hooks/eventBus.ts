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
let es: EventSource | null = null;
let onStatus: ((s: "open" | "closed") => void) | null = null;
let status: "open" | "closed" = "closed";

function ensure() {
  if (es) return;
  es = new EventSource(withTokenQuery("/api/events"));
  es.onopen = () => {
    status = "open";
    onStatus?.(status);
  };
  es.onerror = () => {
    status = "closed";
    onStatus?.(status); // EventSource auto-reconnects; UI keeps slow polling
  };
  es.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data as string) as EntityEvent;
      recent.push(e);
      if (recent.length > BUFFER) recent.splice(0, recent.length - BUFFER);
      for (const l of listeners) l(e);
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

export function onStreamStatus(cb: (s: "open" | "closed") => void) {
  onStatus = cb;
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

/** Rolling event buffer for the observability stream view. */
export function useEventBuffer(entityTypes?: string[]) {
  const [events, setEvents] = useState<EntityEvent[]>(() => recent);
  useEffect(() => {
    const cb = () => setEvents([...recent]);
    const u = subscribeEvents(cb);
    cb();
    return u;
  }, []);
  return entityTypes?.length
    ? events.filter((e) => entityTypes.includes(e.entity_type))
    : events;
}
