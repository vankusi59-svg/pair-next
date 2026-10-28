/* Personal Mode (UI-V2) — client-side session seam.
 *
 * One module owns every /api/personal/* call and the resolved session
 * state. All requests are plain same-origin fetch — the session cookie
 * is HttpOnly and travels automatically; no token is ever read, written,
 * or exposed to this code path.
 *
 * Trust contract (docs/personal-mode/ARCHITECTURE.md):
 *   - session mint/consume exists only on the local listener;
 *   - remote/tunnel ingress gets status truth but never a session;
 *   - the resolved operator is the server-pinned canonical owner —
 *     display only, never client-chosen authority.
 */

export interface PersonalSessionInfo {
  operator: string;
  business_id: string | null;
  expires_at: string;
}

export interface PersonalStatus {
  personal_mode: boolean;
  ingress: "local" | "remote";
  session: PersonalSessionInfo | null;
  needs_owner_selection: boolean;
  owner_candidates: string[];
  eligible_businesses: string[];
}

let cachedStatus: PersonalStatus | null = null;
let sessionInfo: PersonalSessionInfo | null = null;
let ensureAttempted = false;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function onSessionChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function hasPersonalSession(): boolean {
  return sessionInfo !== null;
}

export function personalSessionInfo(): PersonalSessionInfo | null {
  return sessionInfo;
}

export function personalModeAvailable(): boolean {
  return cachedStatus?.personal_mode === true && cachedStatus.ingress === "local";
}

/** Server-verified eligible businesses for the bound owner (empty on
 *  remote ingress or when nothing is resolvable — never a global list). */
export function eligibleBusinesses(): string[] {
  return cachedStatus?.eligible_businesses ?? [];
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/personal${path}`, {
    ...init,
    headers: { "content-type": "application/json" },
  });
  const text = await r.text();
  let body: Record<string, unknown> = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (!r.ok) {
    const err = new Error(String(body.error ?? `HTTP_${r.status}`));
    (err as Error & { status: number; body: unknown }).status = r.status;
    (err as Error & { status: number; body: unknown }).body = body;
    throw err;
  }
  return body as T;
}

export async function fetchPersonalStatus(): Promise<PersonalStatus> {
  const st = await call<PersonalStatus>("/session");
  cachedStatus = st;
  if (st.session) sessionInfo = st.session;
  else if (st.ingress !== "local") sessionInfo = null;
  return st;
}

export async function bootstrapPersonal(): Promise<PersonalStatus> {
  try {
    const r = await call<{
      personal_mode: boolean;
      ingress: "local";
      session: PersonalSessionInfo;
      eligible_businesses: string[];
    }>("/session/bootstrap", { method: "POST", body: "{}" });
    sessionInfo = r.session;
    cachedStatus = {
      personal_mode: true,
      ingress: "local",
      session: r.session,
      needs_owner_selection: false,
      owner_candidates: [],
      eligible_businesses: r.eligible_businesses ?? [],
    };
    notify();
    return cachedStatus;
  } catch (e) {
    const err = e as Error & { status?: number; body?: { needs_owner_selection?: boolean; owner_candidates?: string[] } };
    if (err.status === 409 && err.body?.needs_owner_selection) {
      cachedStatus = {
        personal_mode: true,
        ingress: "local",
        session: null,
        needs_owner_selection: true,
        owner_candidates: err.body.owner_candidates ?? [],
        eligible_businesses: [],
      };
      return cachedStatus;
    }
    throw e;
  }
}

export async function selectPersonalOwner(owner: string): Promise<PersonalStatus> {
  const r = await call<{ session: PersonalSessionInfo }>("/session/select-owner", {
    method: "POST",
    body: JSON.stringify({ owner }),
  });
  sessionInfo = r.session;
  cachedStatus = {
    personal_mode: true,
    ingress: "local",
    session: r.session,
    needs_owner_selection: false,
    owner_candidates: [],
    eligible_businesses: [],
  };
  const st = await fetchPersonalStatus().catch(() => cachedStatus);
  notify();
  return st!;
}

export async function setSessionBusiness(businessId: string): Promise<void> {
  const r = await call<{ session: PersonalSessionInfo }>("/session/business", {
    method: "POST",
    body: JSON.stringify({ business_id: businessId }),
  });
  sessionInfo = r.session;
  if (cachedStatus?.session) cachedStatus = { ...cachedStatus, session: r.session };
  notify();
}

export async function logoutPersonal(): Promise<void> {
  await call("/session/logout", { method: "POST", body: "{}" }).catch(() => undefined);
  sessionInfo = null;
  if (cachedStatus) cachedStatus = { ...cachedStatus, session: null };
  notify();
}

/** One-shot silent ensure used by the shared transport on a 401:
 *  memoized per page load — a refused bootstrap is never retried in a
 *  loop. Returns true when a session now authenticates requests. */
export async function ensurePersonalSession(): Promise<boolean> {
  if (sessionInfo) return true;
  if (ensureAttempted) return false;
  ensureAttempted = true;
  try {
    const st = await fetchPersonalStatus();
    if (st.session) { notify(); return true; }
    if (!st.personal_mode || st.ingress !== "local") return false;
    const boot = await bootstrapPersonal();
    return boot.session !== null;
  } catch {
    return false;
  }
}

export function resetPersonalSessionState(): void {
  cachedStatus = null;
  sessionInfo = null;
  ensureAttempted = false;
}
