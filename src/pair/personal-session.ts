/**
 * personal-session — trusted-local Personal Mode (UI-V2 Personal Mode).
 *
 * A server-managed, same-origin browser session for the local owner
 * dashboard. Explicit opt-in via PAIR_PERSONAL_MODE=local; when the flag
 * is absent/off the module produces no sessions and the bearer flow is
 * byte-identical to before (rollback requires no data migration).
 *
 * Trust boundary (see docs/personal-mode/ARCHITECTURE.md):
 *   - The canonical live stack runs TWO listeners on the same handler —
 *     a loopback-only local listener (session-capable) and a separate
 *     remote/tunnel listener (never session-capable). Ingress class is
 *     derived from req.socket.localPort — socket truth — plus a
 *     proxy-marker belt check for misconfigurations.
 *   - Session ids are 256-bit opaque; the store keeps only sha256(id)
 *     so a durable read never yields a usable credential.
 *   - A session maps to the ordinary `operator` credential class ONLY.
 *     It can never satisfy the admin, broker, outbox or artifact lanes.
 *
 * Owner continuity: the bound canonical owner lives in
 * `personal_binding:pb:deployment`. It is derived from existing
 * objective owner_authority_id values via the canonical strict read;
 * ambiguous deployments get a one-time explicit selection, never a
 * silent merge/transfer.
 */

import crypto from "node:crypto";
import type http from "node:http";
import { IntegrityError } from "./errors.js";
import type { PairEvidenceStore } from "./store.js";
import { utcnow } from "./canonical.js";

export const PERSONAL_MODE_ENV = "PAIR_PERSONAL_MODE";
export const PERSONAL_SESSION_COOKIE = "pair_ps";
export const PERSONAL_BINDING_ENTITY = "personal_binding";
export const PERSONAL_SESSION_ENTITY = "personal_session";
export const PERSONAL_BINDING_ID = "pb:deployment";

/** Rolling session lifetime — a bootstrap is silent, so expiry never
 *  strands the owner; it simply re-mints on the next page load. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Proxy/tunnel markers that prove a request arrived forwarded — never
 *  directly from a local browser. Checked on the local listener as a
 *  belt layer under the socket-port boundary (a tunnel mis-pointed at
 *  the privileged port still carries its edge headers). */
const PROXY_MARKER_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "forwarded",
  "via",
  "x-real-ip",
  "cdn-loop",
  "cf-ray",
  "cf-connecting-ip",
  "cf-visitor",
  "cf-ipcountry",
  "cf-request-id",
  "cf-device-type",
  "cf-warp-tag-id",
];

const LOOPBACK_ADDRS = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

export type PersonalMode = "local" | "off";

/** PAIR_PERSONAL_MODE — only the literal value "local" enables the
 *  mode; everything else (unset included) is the legacy bearer path.
 *  Fail-closed: no fuzzy matching, no truthy coercion. */
export function personalMode(env: Record<string, string | undefined> = process.env): PersonalMode {
  const raw = env[PERSONAL_MODE_ENV];
  if (raw === undefined || raw.trim() === "") return "off";
  const v = raw.trim().toLowerCase();
  if (v === "local") return "local";
  if (v === "off" || v === "0" || v === "false") return "off";
  // An unrecognized configured value is ambiguous operator intent —
  // fail closed rather than silently widening or silently ignoring.
  throw new IntegrityError(
    "FAIL_CLOSED_PERSONAL_MODE_INVALID",
    `${PERSONAL_MODE_ENV}=${raw}: only "local" enables Personal Mode`,
  );
}

export type IngressClass = "local" | "remote";

function hostIsLoopback(host: string): boolean {
  const h = host.trim().toLowerCase();
  const name = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0] ?? "";
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

/** Ingress classification for a request against the personal-capable
 *  listener port. `local` requires ALL of:
 *    - arrived on the designated local listener (socket localPort)
 *    - loopback peer address
 *    - zero proxy/forwarding markers (cloudflared edge always sets cf-*)
 *    - loopback Host
 *  Anything else is `remote` — session auth never applies there. */
export function classifyPersonalIngress(
  req: http.IncomingMessage,
  localPort: number,
): IngressClass {
  if (!Number.isInteger(localPort) || localPort < 1) return "remote";
  if (req.socket.localPort !== localPort) return "remote";
  const peer = String(req.socket.remoteAddress ?? "");
  if (!LOOPBACK_ADDRS.has(peer)) return "remote";
  for (const h of PROXY_MARKER_HEADERS) {
    if (req.headers[h] !== undefined) return "remote";
  }
  const host = String(req.headers.host ?? "");
  if (!host || !hostIsLoopback(host)) return "remote";
  return "local";
}

/** CSRF/origin proof for browser-originated mutations. Rules:
 *   - Origin present → must parse and its host must equal the request
 *     Host AND be loopback-shaped (same-origin local dashboard).
 *   - Sec-Fetch-Site present → must be same-origin/same-site/none —
 *     cross-site browser sends are refused outright.
 *   - Both absent → a non-browser local client (curl/bridge); local
 *     processes already hold machine-level trust (they can read the
 *     token file) so they are not the defended class. */
export function assertPersonalOrigin(req: http.IncomingMessage): void {
  const origin = String(req.headers.origin ?? "");
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new IntegrityError("FAIL_CLOSED_PERSONAL_ORIGIN", "unparseable Origin");
    }
    const host = String(req.headers.host ?? "");
    if (!host || originHost.toLowerCase() !== host.toLowerCase() || !hostIsLoopback(originHost)) {
      throw new IntegrityError(
        "FAIL_CLOSED_PERSONAL_ORIGIN",
        `Origin ${origin.slice(0, 80)} does not match local Host`,
      );
    }
  }
  const fetchSite = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) {
    throw new IntegrityError(
      "FAIL_CLOSED_PERSONAL_ORIGIN",
      `Sec-Fetch-Site ${fetchSite} rejected`,
    );
  }
}

export function parsePersonalCookie(req: http.IncomingMessage): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === PERSONAL_SESSION_COOKIE) {
      const v = part.slice(eq + 1).trim();
      return /^[0-9a-f]{64}$/.test(v) ? v : null;
    }
  }
  return null;
}

export function mintSessionCookie(sessionId: string, secure: boolean): string {
  const parts = [
    `${PERSONAL_SESSION_COOKIE}=${sessionId}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(): string {
  return `${PERSONAL_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

function sessionEntityId(sessionId: string): string {
  return `ps:${crypto.createHash("sha256").update(sessionId, "utf8").digest("hex")}`;
}

interface BindingRow extends Record<string, unknown> {
  entity_type: string;
  entity_id: string;
  version: number;
  operator: string;
  business_id: string | null;
  source: "derived" | "selected" | "fresh";
  created_at: string;
  updated_at: string;
}

interface SessionRow extends Record<string, unknown> {
  entity_type: string;
  entity_id: string;
  version: number;
  operator: string;
  created_at: string;
  expires_at: string;
  revoked: boolean;
}

export interface PersonalSessionInfo {
  operator: string;
  business_id: string | null;
  expires_at: string;
}

export interface PersonalStatus {
  personal_mode: boolean;
  ingress: IngressClass;
  session: PersonalSessionInfo | null;
  needs_owner_selection: boolean;
  owner_candidates: string[];
  eligible_businesses: string[];
}

/**
 * One canonical owner-resolution seam injected by server wiring —
 * production binds biz.objectives.strictEnumerate() owner ids; tests
 * inject deterministic lists. Returns the set of distinct canonical
 * owner identities (operator:...).
 */
export type OwnerIdSource = () => string[];

/** Owner-scoped eligible businesses — production derives them from
 *  strictEnumerate (owner owns ≥1 objective in the business). */
export type EligibleBusinessSource = (operator: string) => string[];

export class PersonalSessionService {
  constructor(private deps: {
    store: PairEvidenceStore;
    listOwnerIds: OwnerIdSource;
    eligibleBusinesses: EligibleBusinessSource;
  }) {}

  private binding(): BindingRow | null {
    return this.deps.store.tryGet<BindingRow>(PERSONAL_BINDING_ENTITY, PERSONAL_BINDING_ID);
  }

  private putBinding(next: Partial<BindingRow> & Pick<BindingRow, "operator">): BindingRow {
    const prev = this.binding();
    const now = utcnow();
    const row: BindingRow = {
      entity_type: PERSONAL_BINDING_ENTITY,
      entity_id: PERSONAL_BINDING_ID,
      version: prev ? prev.version : 0,
      operator: next.operator,
      business_id: next.business_id !== undefined ? next.business_id : (prev?.business_id ?? null),
      source: next.source ?? prev?.source ?? "derived",
      created_at: prev?.created_at ?? now,
      updated_at: now,
    };
    return this.deps.store.put(PERSONAL_BINDING_ENTITY, PERSONAL_BINDING_ID, row);
  }

  /** Validate a cookie session id → pinned operator, or null. Revoked,
   *  expired or unknown sessions authenticate nothing; the caller turns
   *  that into the ordinary 401 path. */
  authenticate(sessionId: string | null): PersonalSessionInfo | null {
    if (!sessionId) return null;
    const row = this.deps.store.tryGet<SessionRow>(PERSONAL_SESSION_ENTITY, sessionEntityId(sessionId));
    if (!row || row.revoked === true) return null;
    if (String(row.expires_at) <= utcnow()) return null;
    const binding = this.binding();
    // The binding is the authority — a session outliving a binding
    // change re-pins to the current binding operator only when it still
    // matches; a mismatched residue authenticates nothing.
    if (!binding || binding.operator !== row.operator) return null;
    return { operator: row.operator, business_id: binding.business_id, expires_at: row.expires_at };
  }

  private mintSession(operator: string): { sessionId: string; info: PersonalSessionInfo } {
    const sessionId = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const binding = this.binding();
    this.deps.store.put(PERSONAL_SESSION_ENTITY, sessionEntityId(sessionId), {
      entity_type: PERSONAL_SESSION_ENTITY,
      entity_id: sessionEntityId(sessionId),
      version: 0,
      operator,
      created_at: utcnow(),
      expires_at: expires,
      revoked: false,
    });
    return { sessionId, info: { operator, business_id: binding?.business_id ?? null, expires_at: expires } };
  }

  /** Resolve the canonical owner for a fresh bootstrap:
   *   existing binding → reuse verbatim;
   *   1 derived owner → auto-bind;
   *   0 → mint a stable fresh owner, persisted;
   *   >1 → needs explicit selection (candidates returned). */
  resolveOwner(): { bound: string | null; candidates: string[] } {
    const existing = this.binding();
    if (existing) return { bound: existing.operator, candidates: [] };
    const owners = [...new Set(this.deps.listOwnerIds().map(String))].sort();
    if (owners.length === 1) {
      this.putBinding({ operator: owners[0]!, source: "derived" });
      return { bound: owners[0]!, candidates: [] };
    }
    if (owners.length === 0) {
      const fresh = `operator:personal:${crypto.randomBytes(8).toString("hex")}`;
      this.putBinding({ operator: fresh, source: "fresh" });
      return { bound: fresh, candidates: [] };
    }
    return { bound: null, candidates: owners };
  }

  /** Explicit one-time selection — only a derived candidate may be
   *  bound; anything else is a forged claim and fails closed. */
  selectOwner(owner: string): { sessionId: string; info: PersonalSessionInfo } {
    const owners = [...new Set(this.deps.listOwnerIds().map(String))].sort();
    if (!owners.includes(owner)) {
      throw new IntegrityError(
        "FAIL_CLOSED_PERSONAL_OWNER",
        `owner ${owner.slice(0, 80)} is not an evidenced canonical owner`,
      );
    }
    const existing = this.binding();
    if (existing && existing.operator !== owner) {
      // Re-binding across owners is an explicit destructive act — never
      // silently allowed through the session seam.
      throw new IntegrityError(
        "FAIL_CLOSED_PERSONAL_OWNER_BOUND",
        `binding already committed to ${existing.operator}`,
      );
    }
    this.putBinding({ operator: owner, source: "selected" });
    return this.mintSession(owner);
  }

  bootstrap(): { sessionId: string | null; info: PersonalSessionInfo | null; needs_owner_selection: boolean; candidates: string[] } {
    const { bound, candidates } = this.resolveOwner();
    if (!bound) {
      return { sessionId: null, info: null, needs_owner_selection: true, candidates };
    }
    const { sessionId, info } = this.mintSession(bound);
    return { sessionId, info, needs_owner_selection: false, candidates: [] };
  }

  /** Persist the owner's business preference — only an evidenced
   *  eligible business (owner owns ≥1 objective in it) may be bound;
   *  empty string clears. A stale preference is never silently kept. */
  setBusiness(sessionId: string | null, businessId: string): PersonalSessionInfo {
    const sess = this.authenticate(sessionId);
    if (!sess) {
      throw new IntegrityError("FAIL_CLOSED_PERSONAL_SESSION", "no valid session");
    }
    const trimmed = businessId.trim();
    if (trimmed) {
      const eligible = this.deps.eligibleBusinesses(sess.operator);
      if (!eligible.includes(trimmed)) {
        throw new IntegrityError(
          "FAIL_CLOSED_PERSONAL_BUSINESS",
          `business ${trimmed.slice(0, 80)} is not accessible to ${sess.operator}`,
        );
      }
    }
    this.putBinding({ operator: sess.operator, business_id: trimmed || null });
    return { operator: sess.operator, business_id: trimmed || null, expires_at: sess.expires_at };
  }

  revoke(sessionId: string | null): void {
    if (!sessionId) return;
    const row = this.deps.store.tryGet<SessionRow>(PERSONAL_SESSION_ENTITY, sessionEntityId(sessionId));
    if (!row) return;
    this.deps.store.put(PERSONAL_SESSION_ENTITY, sessionEntityId(sessionId), {
      ...row,
      revoked: true,
    });
  }

  /** Auto-select the sole eligible business on bootstrap when the
   *  binding carries no preference; drop a preference that went stale. */
  reconcileBusinessPreference(operator: string): string | null {
    const binding = this.binding();
    if (!binding) return null;
    const eligible = this.deps.eligibleBusinesses(operator);
    if (binding.business_id && !eligible.includes(binding.business_id)) {
      this.putBinding({ operator, business_id: null });
      return eligible.length === 1 ? this.setBusinessPreference(operator, eligible[0]!) : null;
    }
    if (!binding.business_id && eligible.length === 1) {
      return this.setBusinessPreference(operator, eligible[0]!);
    }
    return binding.business_id;
  }

  private setBusinessPreference(operator: string, businessId: string): string {
    this.putBinding({ operator, business_id: businessId });
    return businessId;
  }

  status(ingress: IngressClass, sessionId: string | null): PersonalStatus {
    const sess = this.authenticate(sessionId);
    const bound = this.binding();
    const ownerCandidates = sess || bound ? [] : [...new Set(this.deps.listOwnerIds().map(String))].sort();
    const operator = sess?.operator ?? bound?.operator ?? null;
    const eligible = operator ? this.deps.eligibleBusinesses(operator) : [];
    if (sess) {
      const reconciled = this.reconcileBusinessPreference(sess.operator);
      sess.business_id = reconciled;
    }
    return {
      personal_mode: true,
      ingress,
      session: sess,
      needs_owner_selection: !sess && ingress === "local" && !bound && ownerCandidates.length > 1,
      owner_candidates: ingress === "local" && !sess && !bound && ownerCandidates.length > 1 ? ownerCandidates : [],
      eligible_businesses: ingress === "local" ? eligible : [],
    };
  }
}
