/** P15.10-D — delegated KPI verification authority (core, pure validators).
 *
 *  The ONE extension of the P15.1 owner-verifier seam: an owner may mint a
 *  scoped `objective_kpi_auto_authorization` grant that lets the canonical
 *  writer (identity `PAIR_KPI_VERIFIER`) record KPI progress on evidence it
 *  can fully re-derive. This module is dependency-light by design: it only
 *  needs the store, so BOTH the write path (objective-authority
 *  assertOwnerVerifier) and the strict-read path (P15.5
 *  assertCanonicalObjectiveKpiProgress) re-validate the same contract.
 *
 *  What this is NOT: the owner does not impersonate itself — the verifier
 *  string is `kpi-verifier:<authorization_id>`, never `operator:<owner>`.
 *  Authority flows from a live grant row + a digest-bound receipt, not from
 *  the actor string (any caller may write that string; only a real grant +
 *  receipt survive re-validation).
 */

import { digest } from "./canonical.js";
import { IntegrityError, NotFoundError } from "./errors.js";
import type { PairEvidenceStore } from "./store.js";

type Row = Record<string, unknown> & { version: number };

export const KPI_AUTH_ENTITY = "objective_kpi_auto_authorization";
export const KPI_RECEIPT_ENTITY = "kpi_verification_receipt";
export const KPI_VERIFIER_KIND = "kpi-verifier";
/** The ONE canonical writer identity for auto-verified KPI progress. */
export const KPI_VERIFIER_WRITER = "PAIR_KPI_VERIFIER";
export const KPI_VERIFIER_SCHEMA = "pair.os.vnext.kpi-auto-auth.v1";
export const KPI_RECEIPT_SCHEMA = "pair.os.vnext.kpi-receipt.v1";

export const KPI_AUTH_STATES = ["ENABLED", "DISABLED", "REVOKED"] as const;
export type KpiAuthState = (typeof KPI_AUTH_STATES)[number];

/** Bounded rule vocabulary — deliverable-bundle verification only. KPIs that
 *  measure the outside world (e.g. Telegram members) are NOT deliverable
 *  verifiable: the grant create path rejects every other rule_type. */
export const KPI_VERIFY_RULE_TYPES = ["DELIVERABLE_BUNDLE"] as const;
export type KpiVerifyRuleType = (typeof KPI_VERIFY_RULE_TYPES)[number];

export interface KpiVerifyRule {
  rule_type: KpiVerifyRuleType;
  /** Verified workstream units required (all committed children folded
   *  COMPLETED with ≥1 ACCEPTED artifact attributed to their bound mission). */
  required_count?: number;
  /** Exact committed workstream keys that must be verified. */
  required_keys?: string[];
  /** Value written to kpi.current when the bundle is satisfied (default 1). */
  progress_value?: number;
}

export function verifierRefOf(verifier: string, kind: string): string {
  const prefix = `${kind}:`;
  return verifier.startsWith(prefix) ? verifier.slice(prefix.length) : "";
}

export function kpiAuthFail(detail: string): never {
  throw new IntegrityError("FAIL_CLOSED_KPI_VERIFY", detail);
}

/** Strict rule normalization — unknown fields or shapes reject at configure
 *  time; nothing is inferred from the KPI name or CEO text. */
export function normalizeKpiVerifyRule(raw: unknown): Required<Omit<KpiVerifyRule, "required_count" | "required_keys">> &
  Pick<KpiVerifyRule, "required_count" | "required_keys"> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    kpiAuthFail("rule must be an object");
  }
  const src = raw as Record<string, unknown>;
  for (const k of Object.keys(src)) {
    if (!["rule_type", "required_count", "required_keys", "progress_value"].includes(k)) {
      kpiAuthFail(`rule unknown field ${k}`);
    }
  }
  if (src.rule_type !== "DELIVERABLE_BUNDLE") {
    kpiAuthFail(`rule_type ${String(src.rule_type)} unsupported — only DELIVERABLE_BUNDLE is verifiable`);
  }
  const requiredCount =
    src.required_count === undefined || src.required_count === null
      ? undefined
      : (() => {
          const n = Number(src.required_count);
          if (!Number.isInteger(n) || n < 1 || n > 256) {
            kpiAuthFail("required_count must be integer 1..256");
          }
          return n;
        })();
  let requiredKeys: string[] | undefined;
  if (src.required_keys !== undefined && src.required_keys !== null) {
    if (
      !Array.isArray(src.required_keys) ||
      src.required_keys.length === 0 ||
      src.required_keys.length > 256 ||
      src.required_keys.some((v) => typeof v !== "string" || !v.trim() || v.length > 128)
    ) {
      kpiAuthFail("required_keys must be non-empty string[] (≤256, ≤128 chars)");
    }
    requiredKeys = src.required_keys.map((v) => String(v).trim());
    if (new Set(requiredKeys).size !== requiredKeys.length) {
      kpiAuthFail("required_keys contains duplicates");
    }
  }
  if (requiredCount === undefined && requiredKeys === undefined) {
    kpiAuthFail("rule requires required_count and/or required_keys");
  }
  const progressValue =
    src.progress_value === undefined || src.progress_value === null
      ? 1
      : (() => {
          const n = Number(src.progress_value);
          if (!Number.isFinite(n)) kpiAuthFail("progress_value must be finite");
          return n;
        })();
  return {
    rule_type: "DELIVERABLE_BUNDLE",
    required_count: requiredCount,
    required_keys: requiredKeys,
    progress_value: progressValue,
  };
}

/** The grant contract, normalized at write time. */
export function kpiAuthRow(
  store: PairEvidenceStore,
  authorizationId: string,
): Row | null {
  return store.tryGet<Row>(KPI_AUTH_ENTITY, authorizationId);
}

/** Evaluate a grant against a CURRENT objective row — the same checks the
 *  write path and the read path must agree on. Returns the failure reason or
 *  null when the grant is effective for (objective,kpi) at `now`. */
export function kpiAuthEffectiveReason(
  grant: Row | null,
  objective: Row,
  kpiId: string,
  now: number,
): string | null {
  if (!grant) return "NO_AUTHORIZATION";
  if (String(grant.objective_id) !== String(objective.objective_id)) return "OBJECTIVE_MISMATCH";
  if (String(grant.business_id) !== String(objective.business_id)) return "BUSINESS_MISMATCH";
  if (kpiId && String(grant.kpi_id) !== String(kpiId)) return "KPI_MISMATCH";
  if (String(grant.owner_authority_id) !== String(objective.owner_authority_id)) {
    return "OWNER_MISMATCH";
  }
  if (String(grant.state) !== "ENABLED") return `AUTH_${String(grant.state)}`;
  if (Number(grant.objective_terms_version) !== Number(objective.terms_version)) {
    return "TERMS_DRIFT";
  }
  const exp = Date.parse(String(grant.expires_at));
  if (!Number.isFinite(exp) || exp <= now) return "AUTH_EXPIRED";
  if (["ACHIEVED", "INFEASIBLE", "CANCELLED", "EXPIRED"].includes(
    String(objective.status))) {
    return "OBJECTIVE_TERMINAL";
  }
  return null;
}

/** Recompute a receipt's bound digest — binds every dimension that could
 *  distinguish two different measurements. */
export function kpiReceiptDigest(r: Record<string, unknown>): string {
  return digest({
    schema: KPI_RECEIPT_SCHEMA,
    authorization_id: String(r.authorization_id),
    objective_id: String(r.objective_id),
    business_id: String(r.business_id),
    kpi_id: String(r.kpi_id),
    objective_terms_version: Number(r.objective_terms_version),
    rule_digest: String(r.rule_digest),
    verified_units: r.verified_units,
    progress_value: Number(r.progress_value),
  });
}

export function kpiEvidenceKey(authorizationId: string, receiptId: string): string {
  return `kva:${authorizationId}:${receiptId}`;
}

/** Locate the canonical receipt a measurement already produced —
 *  replay is a no-op: same units/digest ⇒ same receipt, never a new
 *  progress event. */
export function kpiReceiptByDigest(
  store: PairEvidenceStore,
  receiptDigest: string,
): Row | null {
  return (
    store
      .list<Row>(KPI_RECEIPT_ENTITY)
      .find((r) => String(r.receipt_digest) === receiptDigest) ?? null
  );
}

/** THE shared verifier re-validation — used inside recordProgress's write
 *  transaction AND by the P15.5 strict-read. Fails closed on any gap:
 *  grant effective for (objective,kpi) + receipt exists for evidence_key +
 *  receipt digest recomputes + receipt binds this objective/kpi/value/terms +
 *  receipt produced by the canonical writer. */
export function assertKpiVerifierAuthority(args: {
  store: PairEvidenceStore;
  objective: Row;
  /** KPI/evidence claim context. PROGRESS writes always pass both; a
   *  plain EVIDENCE attach (no measurement claim) omits them and the
   *  receipt's own bound fields carry the proof. */
  kpi_id?: string;
  verifier: string;
  evidence_key: string;
  value?: number;
}): void {
  const { store, objective, verifier, evidence_key } = args;
  const authId = verifierRefOf(verifier, KPI_VERIFIER_KIND);
  if (!authId) kpiAuthFail(`verifier ${verifier}: malformed ${KPI_VERIFIER_KIND} reference`);
  const now = Date.now();
  const grant = kpiAuthRow(store, authId);
  const reason = kpiAuthEffectiveReason(grant, objective, args.kpi_id ?? "", now);
  if (reason) {
    kpiAuthFail(`verifier ${verifier}: authorization not effective (${reason})`);
  }
  // Grant's pinned kpi must be the kpi named in the claim (progress write)
  // or the kpi the receipt binds (evidence attach) — checked again below
  // once the receipt is loaded.
  const parts = evidence_key.split(":");
  if (parts.length !== 3 || parts[0] !== "kva" || parts[1] !== authId || !parts[2]) {
    kpiAuthFail(`evidence_key ${evidence_key}: not bound to authorization ${authId}`);
  }
  const receipt = store.tryGet<Row>(KPI_RECEIPT_ENTITY, parts[2]!);
  if (!receipt) {
    kpiAuthFail(`evidence_key ${evidence_key}: receipt ${parts[2]} missing`);
  }
  // F3 — strict receipt↔authorization binding: the receipt must be the
  // one THIS authorization minted, under THIS authorization's current
  // rule, carrying its own immutable evidence key. A receipt minted by
  // a revoked/other grant, a grant whose rule was tampered after mint,
  // or a key string that is not the receipt's minted key all fail.
  if (String(receipt.authorization_id) !== authId) {
    kpiAuthFail(
      `receipt ${parts[2]}: binds authorization ${String(receipt.authorization_id)}, not ${authId}`,
    );
  }
  if (String(receipt.evidence_key) !== evidence_key) {
    kpiAuthFail(
      `receipt ${parts[2]}: evidence_key ${evidence_key} is not the minted key`,
    );
  }
  if (String(receipt.rule_digest) !== String(grant!.rule_digest)) {
    kpiAuthFail(
      `receipt ${parts[2]}: rule_digest does not bind grant rule_digest`,
    );
  }
  if (String(receipt.produced_by) !== KPI_VERIFIER_WRITER) {
    kpiAuthFail(`receipt ${parts[2]}: produced_by ${String(receipt.produced_by)} is not the canonical writer`);
  }
  if (kpiReceiptDigest(receipt) !== String(receipt.receipt_digest)) {
    kpiAuthFail(`receipt ${parts[2]}: digest mismatch — forged or mutated receipt`);
  }
  if (
    String(receipt.objective_id) !== String(objective.objective_id) ||
    String(receipt.business_id) !== String(objective.business_id) ||
    Number(receipt.objective_terms_version) !== Number(objective.terms_version)
  ) {
    kpiAuthFail(`receipt ${parts[2]}: does not bind this objective/terms`);
  }
  if (String(receipt.kpi_id) !== String(grant!.kpi_id)) {
    kpiAuthFail(`receipt ${parts[2]}: kpi ${String(receipt.kpi_id)} does not bind grant kpi ${String(grant!.kpi_id)}`);
  }
  if (args.kpi_id !== undefined && String(receipt.kpi_id) !== String(args.kpi_id)) {
    kpiAuthFail(`receipt ${parts[2]}: kpi ${String(receipt.kpi_id)} does not bind claimed kpi ${args.kpi_id}`);
  }
  if (args.value !== undefined && Number(receipt.progress_value) !== Number(args.value)) {
    kpiAuthFail(`receipt ${parts[2]}: value ${String(receipt.progress_value)} does not bind claimed value ${args.value}`);
  }
}

export function kpiAuthNotFound(id: string): never {
  throw new NotFoundError(`${KPI_AUTH_ENTITY}:${id}`);
}
