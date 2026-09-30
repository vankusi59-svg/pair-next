/**
 * P14 WORKFORCE V2 PHASE 2 — canonical coordination authority.
 *
 * Coordination ≠ execution. A claim lease, heartbeat, inbox message or
 * receipt carries ZERO execution authority: it cannot create a mission,
 * grant a capability, assign a graph-bound item, satisfy a dependency,
 * or bypass BusinessLayer.openWorkItem → work_open_binding → governed
 * mission path.
 *
 * Canonical entities:
 *   - `work_claim_lease`   (WCL_<work_item_id>)  one current lease row
 *     per work item; epochs+token digests fence stale holders.
 *   - `workforce_message`  (WFM_<id>)            append-only durable
 *     collaboration message (NOTE/REQUEST/STATUS/BLOCKER_NOTICE/
 *     HANDOFF_REQUEST — all non-authoritative).
 *   - `workforce_message_receipt` (WIR_<msg>_<recipient>) immutable
 *     message + separate receipt row so ACKs never rewrite provenance.
 *
 * The mutable work_item `claimed_by` / `claim_expires_at` /
 * `claim_token` fields are OBSERVABILITY MIRRORS ONLY — never consulted
 * as authority; `claim_token` is never written at all (raw tokens exist
 * only in the claim response, never persisted or echoed by any API).
 */

import { canonicalJson, digest, utcnow } from "./canonical.js";
import { IntegrityError, PolicyError } from "./errors.js";
import type { GraphAuthorityDeps } from "./graph-authority.js";
import type { PairEvidenceStore } from "./store.js";

type Row = Record<string, unknown> & { version: number };

export const WORK_CLAIM_LEASE_TABLE = "work_claim_lease";
export const WORKFORCE_MESSAGE_TABLE = "workforce_message";
export const WORKFORCE_RECEIPT_TABLE = "workforce_message_receipt";

export const LEASE_STATES = new Set(["ACTIVE", "RELEASED", "EXPIRED", "REVOKED"]);
export const WORK_MESSAGE_KINDS = new Set([
  "NOTE", "REQUEST", "STATUS", "BLOCKER_NOTICE", "HANDOFF_REQUEST",
]);

export function claimLeaseRowId(workItemId: string): string {
  return `WCL_${workItemId}`;
}
export function receiptRowId(messageId: string, recipientId: string): string {
  return `WIR_${messageId}_${recipientId}`;
}

/** Only the digest of a claim token is ever persisted. */
export function claimTokenDigest(token: string): string {
  return digest(`work-claim-token:${token}`);
}

export function claimLeaseDigest(l: Row): string {
  return digest({
    lease_id: String(l.lease_id),
    work_item_id: String(l.work_item_id),
    business_id: String(l.business_id),
    project_id: String(l.project_id),
    claimant_agent_id: String(l.claimant_agent_id),
    lease_epoch: Number(l.lease_epoch),
    token_digest: String(l.token_digest),
    issued_at: String(l.issued_at),
    last_heartbeat_at: String(l.last_heartbeat_at),
    expires_at: String(l.expires_at),
    state: String(l.state),
  });
}

export function workforceMessageDigest(m: Row): string {
  return digest({
    message_id: String(m.message_id),
    business_id: String(m.business_id),
    work_item_id: m.work_item_id ?? null,
    sender_type: String(m.sender_type),
    sender_agent_id: m.sender_agent_id ?? null,
    sender_operator_id: m.sender_operator_id ?? null,
    recipient_agent_id: String(m.recipient_agent_id),
    kind: String(m.kind),
    body: String(m.body),
    correlation_id: m.correlation_id ?? null,
    created_at: String(m.created_at),
  });
}

function fail(detail: string): never {
  throw new IntegrityError("FAIL_CLOSED_WORK_PROVENANCE_CORRUPT", detail);
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The single canonical lease validator (§14). Consumed identically at
 * every claim/heartbeat/release/open/reconcile seam — no ad-hoc
 * authority anywhere else. Throws FAIL_CLOSED_WORK_PROVENANCE_CORRUPT.
 */
export function assertCanonicalClaimLease(
  deps: GraphAuthorityDeps, lease: Row,
): void {
  const leaseId = String(lease.lease_id ?? lease.entity_id ?? "");
  const wid = String(lease.work_item_id ?? "");
  if (!wid || leaseId !== claimLeaseRowId(wid)) {
    fail(`claim lease ${leaseId}: non-deterministic id`);
  }
  if (!LEASE_STATES.has(String(lease.state ?? ""))) {
    fail(`claim lease ${leaseId}: bad state ${String(lease.state)}`);
  }
  let wi: Row;
  try {
    wi = deps.store.get("work_item", wid) as Row;
  } catch {
    return fail(`claim lease ${leaseId}: work item ${wid} missing`);
  }
  if (String(lease.business_id) !== String(wi.business_id)) {
    fail(`claim lease ${leaseId}: business mismatch`);
  }
  const biz = deps.getBusiness(String(wi.business_id));
  if (String(lease.project_id) !== String(biz.project_id)) {
    fail(`claim lease ${leaseId}: project mismatch`);
  }
  let agent: Row;
  try {
    agent = deps.store.get("org_agent", String(lease.claimant_agent_id)) as Row;
  } catch {
    return fail(`claim lease ${leaseId}: claimant missing`);
  }
  if (String(agent.business_id) !== String(wi.business_id)) {
    fail(`claim lease ${leaseId}: claimant outside business`);
  }
  // For an ACTIVE lease the claimant IS the canonical assignee — claims
  // never reassign and unassigned items never claim (§3). Historical
  // (non-active) leases keep their claimant as provenance; assignee may
  // legitimately have moved on after release/expiry.
  if (String(lease.state) === "ACTIVE") {
    const assignee = wi.assignee_agent_id ? String(wi.assignee_agent_id) : null;
    if (!assignee || assignee !== String(lease.claimant_agent_id)) {
      fail(`claim lease ${leaseId}: claimant != canonical assignee`);
    }
  }
  const epoch = Number(lease.lease_epoch);
  if (!Number.isInteger(epoch) || epoch < 1) {
    fail(`claim lease ${leaseId}: bad epoch ${String(lease.lease_epoch)}`);
  }
  if (!HEX64.test(String(lease.token_digest ?? ""))) {
    fail(`claim lease ${leaseId}: bad token digest shape`);
  }
  // R1 §4 — strict parseable time ordering: issued_at ≤ last_heartbeat_at
  //  < expires_at. A heartbeat at/after the expiry instant is never a
  //  valid window; malformed timestamps are never canonical.
  const issuedMs = Date.parse(String(lease.issued_at ?? ""));
  const hbMs = Date.parse(String(lease.last_heartbeat_at ?? ""));
  const expMs = Date.parse(String(lease.expires_at ?? ""));
  if (
    !Number.isFinite(issuedMs) || !Number.isFinite(hbMs) ||
    !Number.isFinite(expMs) || hbMs < issuedMs || hbMs >= expMs
  ) {
    fail(`claim lease ${leaseId}: issued ≤ heartbeat < expiry ordering invalid`);
  }
  if (String(lease.lease_digest ?? "") !== claimLeaseDigest(lease)) {
    fail(`claim lease ${leaseId}: digest mismatch`);
  }
  // Mirrors can never override the canonical lease: a live mirror that
  // disagrees with an ACTIVE lease is corrupt (a lagging/null mirror is
  // repairable and not poisoned here — reconcile clears/repairs it).
  const mirrorBy = wi.claimed_by ? String(wi.claimed_by) : null;
  if (
    String(lease.state) === "ACTIVE" &&
    mirrorBy !== null &&
    mirrorBy !== String(lease.claimant_agent_id)
  ) {
    fail(`claim lease ${leaseId}: work_item mirror overrides claimant`);
  }
}

export function assertCanonicalWorkforceMessage(
  deps: GraphAuthorityDeps, msg: Row,
): void {
  const mid = String(msg.message_id ?? "");
  if (!mid.startsWith("WFM_")) fail(`message ${mid}: bad id`);
  if (String(msg.state ?? "") !== "COMMITTED") {
    fail(`message ${mid}: state ${String(msg.state)}`);
  }
  try {
    deps.getBusiness(String(msg.business_id));
  } catch {
    return fail(`message ${mid}: business missing`);
  }
  if (msg.work_item_id !== null && msg.work_item_id !== undefined) {
    let wi: Row;
    try {
      wi = deps.store.get("work_item", String(msg.work_item_id)) as Row;
    } catch {
      return fail(`message ${mid}: work item missing`);
    }
    if (String(wi.business_id) !== String(msg.business_id)) {
      fail(`message ${mid}: work item outside business`);
    }
  }
  let recipient: Row;
  try {
    recipient = deps.store.get("org_agent", String(msg.recipient_agent_id)) as Row;
  } catch {
    return fail(`message ${mid}: recipient missing`);
  }
  if (String(recipient.business_id) !== String(msg.business_id)) {
    fail(`message ${mid}: recipient outside business`);
  }
  const senderType = String(msg.sender_type ?? "");
  if (senderType === "AGENT") {
    let sender: Row;
    try {
      sender = deps.store.get("org_agent", String(msg.sender_agent_id)) as Row;
    } catch {
      return fail(`message ${mid}: sender agent missing`);
    }
    if (String(sender.business_id) !== String(msg.business_id)) {
      fail(`message ${mid}: sender outside business`);
    }
  } else if (senderType === "OPERATOR") {
    if (!String(msg.sender_operator_id ?? "").trim()) {
      fail(`message ${mid}: operator sender without identity`);
    }
  } else {
    fail(`message ${mid}: bad sender type ${senderType}`);
  }
  if (!WORK_MESSAGE_KINDS.has(String(msg.kind ?? ""))) {
    fail(`message ${mid}: bad kind ${String(msg.kind)}`);
  }
  if (String(msg.message_digest ?? "") !== workforceMessageDigest(msg)) {
    fail(`message ${mid}: digest mismatch`);
  }
  // R1 §5 — append-only immutability anchor: a self-consistent rehash of
  //  a mutated row is not enough; the immutable hash-chained
  //  WORKFORCE_MESSAGE_SENT event pins the ORIGINAL digest + identity
  //  fields at commit time (body is never copied into the event — the
  //  digest covers it).
  const sent = deps.store.listEvents(WORKFORCE_MESSAGE_TABLE, mid).filter(
    (e) => String(e.event_type) === "WORKFORCE_MESSAGE_SENT");
  if (sent.length !== 1) {
    fail(`message ${mid}: SENT anchor ${sent.length ? "duplicated" : "missing"}`);
  }
  const meta = ((sent[0].metadata ?? {}) as Row);
  const pinned: Array<[string, unknown]> = [
    ["message_id", mid],
    ["business_id", msg.business_id],
    ["work_item_id", msg.work_item_id ?? null],
    ["sender_type", msg.sender_type],
    ["sender_agent_id", msg.sender_agent_id ?? null],
    ["sender_operator_id", msg.sender_operator_id ?? null],
    ["recipient_agent_id", msg.recipient_agent_id],
    ["kind", msg.kind],
    ["correlation_id", msg.correlation_id ?? null],
    ["message_digest", msg.message_digest],
  ];
  for (const [k, v] of pinned) {
    if (String(meta[k] ?? null) !== String(v ?? null)) {
      fail(`message ${mid}: SENT anchor ${k} mismatch`);
    }
  }
}

export function assertCanonicalReceipt(
  deps: GraphAuthorityDeps, r: Row,
): void {
  const rid = String(r.receipt_id ?? "");
  const mid = String(r.message_id ?? "");
  const recip = String(r.recipient_agent_id ?? "");
  if (!mid || !recip || rid !== receiptRowId(mid, recip)) {
    fail(`receipt ${rid}: non-deterministic id`);
  }
  let msg: Row;
  try {
    msg = deps.store.get(WORKFORCE_MESSAGE_TABLE, mid) as Row;
  } catch {
    return fail(`receipt ${rid}: message missing`);
  }
  if (String(msg.recipient_agent_id) !== recip) {
    fail(`receipt ${rid}: recipient mismatch`);
  }
  const st = String(r.status ?? "");
  if (st !== "PENDING" && st !== "ACKNOWLEDGED") {
    fail(`receipt ${rid}: bad status ${st}`);
  }
  if (st === "ACKNOWLEDGED" && !String(r.acknowledged_at ?? "")) {
    fail(`receipt ${rid}: acknowledged without timestamp`);
  }
  if (st === "PENDING" && r.acknowledged_at !== null && r.acknowledged_at !== undefined) {
    fail(`receipt ${rid}: pending with timestamp`);
  }
  // R1 §6 — receipt provenance is independently anchored: creation rides
  //  on the message's SENT event (receipt_id + created_at pinned), and
  //  ACKNOWLEDGED requires the immutable WORKFORCE_MESSAGE_ACKNOWLEDGED
  //  event pinning message_id + recipient + acknowledged_at. A direct
  //  row mutation has no such event → fail closed.
  assertCanonicalWorkforceMessage(deps, msg);
  const evs = deps.store.listEvents(WORKFORCE_MESSAGE_TABLE, mid);
  const sentMeta = (((evs.find((e) => String(e.event_type) === "WORKFORCE_MESSAGE_SENT")
    ?.metadata ?? {}) as Row));
  if (
    String(sentMeta.receipt_id ?? "") !== rid ||
    String(sentMeta.receipt_created_at ?? "") !== String(r.created_at ?? "")
  ) {
    fail(`receipt ${rid}: creation anchor mismatch`);
  }
  const acks = evs.filter((e) => String(e.event_type) === "WORKFORCE_MESSAGE_ACKNOWLEDGED");
  const matchingAcks = acks.filter((e) => {
    const m = ((e.metadata ?? {}) as Row);
    // R2 §4 — the immutable ACK event must pin ALL required fields, not
    //  just recipient+timestamp: a malformed event metadata.message_id
    //  that does not equal the receipt's message fails even when the
    //  event row's entity_id otherwise matches.
    return String(m.message_id ?? "") === mid &&
      String(m.recipient_agent_id ?? "") === recip &&
      String(m.acknowledged_at ?? "") === String(r.acknowledged_at ?? "");
  });
  if (st === "ACKNOWLEDGED" && matchingAcks.length !== 1) {
    fail(`receipt ${rid}: ACK anchor missing`);
  }
  if (st === "PENDING" && acks.some((e) => {
    const m = ((e.metadata ?? {}) as Row);
    return String(m.recipient_agent_id ?? "") === recip;
  })) {
    fail(`receipt ${rid}: PENDING with committed ACK event`);
  }
}

/**
 * R2 §1-§2 — the canonical collaboration bundle for a message: the
 *  message AND its deterministic receipt must BOTH exist and BOTH
 *  validate. A missing receipt is absence of canonical evidence — it
 *  must never be interpreted as PENDING (that would fabricate valid-
 *  looking state). Non-recursive: message and receipt validators are
 *  each called once.
 */
export function assertCanonicalCollaborationBundle(
  deps: GraphAuthorityDeps, msg: Row,
): Row {
  assertCanonicalWorkforceMessage(deps, msg);
  const mid = String(msg.message_id ?? "");
  const recip = String(msg.recipient_agent_id ?? "");
  const rid = receiptRowId(mid, recip);
  const receipt = deps.store.tryGet(WORKFORCE_RECEIPT_TABLE, rid) as Row | null;
  if (!receipt) {
    fail(`message ${mid}: canonical receipt ${rid} missing`);
  }
  assertCanonicalReceipt(deps, receipt);
  return receipt;
}

/** A lease whose expiry clock has passed. State flips to EXPIRED at the
 *  next canonical mutation seam or reconcile — deterministically. */
export function leaseLiveExpired(lease: Row, nowIso: string): boolean {
  return String(lease.state) === "ACTIVE" && String(lease.expires_at) <= nowIso;
}

/** Safe lease metadata — NEVER token material (§2/§13). */
export function safeLeaseView(lease: Row): Record<string, unknown> {
  return {
    lease_id: lease.lease_id,
    work_item_id: lease.work_item_id,
    claimant_agent_id: lease.claimant_agent_id,
    lease_epoch: lease.lease_epoch,
    state: lease.state,
    issued_at: lease.issued_at,
    last_heartbeat_at: lease.last_heartbeat_at,
    expires_at: lease.expires_at,
    version: lease.version,
  };
}

export function claimExpiredError(leaseId: string): PolicyError {
  return new PolicyError("FAIL_CLOSED_WORK_CLAIM_EXPIRED", `lease ${leaseId} expired`);
}

export { utcnow, canonicalJson };
