/**
 * P15.10-A — objective-scoped AUTO-POLICY authority (owner opt-in).
 *
 *   Separates THREE things that must never be conflated:
 *
 *   - policy STATE — an owner-created control record
 *     (`objective_auto_policy` entity, one per objective);
 *   - the OBJECTIVE lifecycle (P15.1) — disabling a policy never
 *     pauses/cancels the objective itself;
 *   - EFFECTIVE auto eligibility — `evaluate()` re-proves binding +
 *     terms + expiry on every read; a stored ENABLED row is not an
 *     authorization until re-validated live.
 *
 *   A is control-plane only: there is NO auto driver yet. `evaluate()`
 *   always reports `driver_ready:false` + `missing` reasons — a
 *   configured policy NEVER means a running autonomous loop.
 *
 *   Owner proof: every mutation re-reads the objective's canonical
 *   `owner_authority_id` inside the writing transaction — the actor
 *   claim comes from the trusted boundary (HTTP `x-operator-id`); a
 *   client-declared owner field is never consulted.
 *
 *   Kill scope (A): OBJECTIVE-level halt only, by that objective's
 *   owner. Business/global halt is DEFERRED — there is no canonical
 *   business-owner authority seam to prove it (approved plan D1).
 */

import { IntegrityError } from "./errors.js";
import { digest, utcnow } from "./canonical.js";
import type { PairEvidenceStore } from "./store.js";
import type { ObjectiveAuthorityService } from "./objective-authority.js";

export const AUTO_POLICY_ENTITY = "objective_auto_policy";
export const AUTO_POLICY_SCHEMA = "pair.os.vnext.objective-auto-policy.v1";
/** Immutable transition anchors — every version bump mints exactly one
 *  event carrying a `pins_digest` of the committed row. A rewritten
 *  row (even self-rehashed) diverges from the newest anchor and fails
 *  closed; a missing/duplicate anchor fails closed too. The `events`
 *  table is append-only INSERT through store.event — entity writers
 *  cannot mint anchors via store.put. */
export const AUTO_POLICY_EVENT_KIND = "OBJECTIVE_AUTO_POLICY_OP";

export const AUTO_POLICY_STATES = [
  "DISABLED",
  "ENABLED",
  "PAUSED",
  "REVOKED",
  "EXPIRED",
  "HALTED",
] as const;
export type AutoPolicyState = (typeof AUTO_POLICY_STATES)[number];

export const AUTO_POLICY_ACTIONS = [
  "configure",
  "enable",
  "pause",
  "resume",
  "disable",
  "revoke",
  "halt",
  "reset_halt",
] as const;
export type AutoPolicyAction = (typeof AUTO_POLICY_ACTIONS)[number];

/** Legal transitions (configure re-arms in DISABLED; EXPIRED is lazy —
 *  written by evaluate() when expires_at passes). */
const TRANSITIONS: Record<string, AutoPolicyState[]> = {
  configure: ["DISABLED", "EXPIRED"],
  enable: ["DISABLED", "PAUSED"],
  pause: ["ENABLED"],
  resume: ["PAUSED"],
  disable: ["ENABLED", "PAUSED", "HALTED"],
  revoke: ["ENABLED", "PAUSED", "DISABLED", "HALTED"],
  halt: ["ENABLED", "PAUSED"],
  reset_halt: ["HALTED"],
};

export interface AutoPolicyLimits {
  /** Required — finite authorization window, ISO instant. */
  expires_at: string;
  max_ceo_calls?: number;
  max_missions?: number;
  max_retries?: number;
  budget_microusd_cap?: number;
}

interface PolicyRow {
  entity_type: string;
  entity_id: string;
  schema_version: string;
  objective_id: string;
  business_id: string;
  owner_authority_id: string;
  state: AutoPolicyState;
  state_reason: string | null;
  policy_version: number;
  limits: AutoPolicyLimits | null;
  /** objectiveDigest() captured at enable — ANY terms_version bump
   *  invalidates authorization on next evaluate (no silent re-auth). */
  terms_digest_binding: string | null;
  /** Durable per-key operation ledger (objective-authority
   *  applied_spend_keys pattern): same key + same op_digest is an
   *  idempotent replay ACROSS ALL past operations, same key + different
   *  digest fails closed. Never shrinks to "last op only". */
  applied_ops: { key: string; action: string; op_digest: string }[];
  /** Last idempotent op — receipt projection of the newest applied op. */
  last_op: { key: string; action: string; op_digest: string } | null;
  last_receipt: Record<string, unknown> | null;
  halt: { scope: "OBJECTIVE"; actor: string; at: string; reason: string } | null;
  created_at: string;
  updated_at: string;
  version: number;
  policy_digest: string;
}

export interface AutoPolicyStatus {
  objective_id: string;
  configured: boolean;
  state: AutoPolicyState;
  effective: boolean;
  reasons: string[];
  policy_version: number | null;
  expires_at: string | null;
  limits: AutoPolicyLimits | null;
  halt: PolicyRow["halt"];
  owner_authority_id: string;
  business_id: string;
  /** A has no driver — always false, always missing reasons listed. */
  driver_ready: false;
  driver_missing: string[];
  terms_digest_binding: string | null;
  terms_current: boolean;
}

function fail(code: string, msg: string): never {
  throw new IntegrityError(code, msg);
}

function assertStr(field: string, v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 512) {
    fail("FAIL_CLOSED_POLICY_SCHEMA", `${field} invalid`);
  }
  return v as string;
}

function assertLimits(v: unknown): AutoPolicyLimits {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    fail("FAIL_CLOSED_POLICY_LIMITS", "limits must be an object");
  }
  const l = v as Record<string, unknown>;
  const exp = assertStr("limits.expires_at", l.expires_at);
  if (Number.isNaN(Date.parse(exp))) {
    fail("FAIL_CLOSED_POLICY_LIMITS", "expires_at is not a timestamp");
  }
  const intCaps: Array<keyof AutoPolicyLimits> = [
    "max_ceo_calls",
    "max_missions",
    "max_retries",
    "budget_microusd_cap",
  ];
  let present = 0;
  const out: AutoPolicyLimits = { expires_at: exp };
  for (const k of intCaps) {
    const val = l[k];
    if (val === undefined || val === null) continue;
    if (!Number.isInteger(val) || Number(val) <= 0) {
      fail("FAIL_CLOSED_POLICY_LIMITS", `${k} must be a positive integer`);
    }
    (out as unknown as Record<string, number>)[k] = val as number;
    if (k !== "max_retries") present++;
  }
  if (present === 0) {
    fail(
      "FAIL_CLOSED_POLICY_LIMITS",
      "limits require at least one cap (max_ceo_calls | max_missions | budget_microusd_cap)",
    );
  }
  return out;
}

function policyDigestOf(r: Omit<PolicyRow, "policy_digest">): string {
  return digest({
    schema: AUTO_POLICY_SCHEMA,
    entity_id: r.entity_id,
    objective_id: r.objective_id,
    business_id: r.business_id,
    owner_authority_id: r.owner_authority_id,
    state: r.state,
    state_reason: r.state_reason,
    policy_version: r.policy_version,
    limits: r.limits,
    terms_digest_binding: r.terms_digest_binding,
    halt: r.halt,
    applied_ops: r.applied_ops,
    last_op: r.last_op,
    last_receipt: r.last_receipt,
  });
}

/** Consent/provenance pins committed in each transition anchor — the
 *  immutable record of WHAT the owner authorized at that version.
 *  Re-proved against the live row on every read/control/replay. */
function pinsDigestOf(r: PolicyRow): string {
  return digest({
    entity_id: r.entity_id,
    objective_id: r.objective_id,
    business_id: r.business_id,
    owner_authority_id: r.owner_authority_id,
    state: r.state,
    state_reason: r.state_reason,
    policy_version: r.policy_version,
    limits: r.limits,
    terms_digest_binding: r.terms_digest_binding,
    halt: r.halt,
    applied_ops: r.applied_ops,
    last_op: r.last_op,
    last_receipt: r.last_receipt,
  });
}

export class ObjectiveAutoPolicyService {
  constructor(
    private readonly store: PairEvidenceStore,
    private readonly objectives: ObjectiveAuthorityService,
    /** Injectable clock — deterministic expiry tests; production uses
     *  Date.now. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  private policyId(objectiveId: string): string {
    return `oap:${objectiveId}`;
  }

  /** Strict read: schema/field/type/digest integrity — a tampered row
   *  fails closed, never mints policy authority. Binding to the
   *  objective is re-proved live in evaluate(), not trusted here. */
  private assertCanonicalRow(r: unknown): asserts r is PolicyRow {
    if (!r || typeof r !== "object") {
      fail("FAIL_CLOSED_POLICY_INTEGRITY", "not an object");
    }
    const p = r as Record<string, unknown>;
    for (const f of [
      "entity_id",
      "objective_id",
      "business_id",
      "owner_authority_id",
      "created_at",
      "updated_at",
    ]) {
      assertStr(f, p[f]);
    }
    if (p.schema_version !== AUTO_POLICY_SCHEMA) {
      fail("FAIL_CLOSED_POLICY_INTEGRITY", `schema=${String(p.schema_version)}`);
    }
    if (!(AUTO_POLICY_STATES as readonly string[]).includes(String(p.state))) {
      fail("FAIL_CLOSED_POLICY_INTEGRITY", `state=${String(p.state)}`);
    }
    if (!Number.isInteger(p.policy_version) || Number(p.policy_version) < 1) {
      fail("FAIL_CLOSED_POLICY_INTEGRITY", "policy_version");
    }
    if (p.limits !== null && (typeof p.limits !== "object" || Array.isArray(p.limits))) {
      fail("FAIL_CLOSED_POLICY_INTEGRITY", "limits shape");
    }
    if (p.limits) assertLimits(p.limits);
    // applied_ops — strict durable-ledger shape (same rules as
    // objective-authority applied_spend_keys): {key, action, op_digest}
    // entries, unique keys — even a duplicate key/digest is malformed.
    if (!Array.isArray(p.applied_ops)) {
      fail("FAIL_CLOSED_POLICY_INTEGRITY", "applied_ops shape");
    }
    const seenKeys = new Set<string>();
    for (const e of p.applied_ops as unknown[]) {
      if (!e || typeof e !== "object") {
        fail("FAIL_CLOSED_POLICY_INTEGRITY", "applied_ops entry");
      }
      const ee = e as Record<string, unknown>;
      if (
        typeof ee.key !== "string" || !ee.key ||
        !(AUTO_POLICY_ACTIONS as readonly string[]).includes(String(ee.action)) ||
        typeof ee.op_digest !== "string" || !ee.op_digest ||
        seenKeys.has(String(ee.key))
      ) {
        fail("FAIL_CLOSED_POLICY_INTEGRITY", "applied_ops entry invalid");
      }
      seenKeys.add(String(ee.key));
    }
    if (
      p.policy_digest !==
      policyDigestOf({ ...(p as unknown as PolicyRow) })
    ) {
      fail("FAIL_CLOSED_POLICY_INTEGRITY", "policy_digest mismatch");
    }
  }

  /** F1 — anchor re-proof: the live row must be consistent with the
   *  immutable committed anchors in the events table. Exactly one
   *  anchor per policy_version, an unbroken from_state chain, and the
   *  newest anchor's pins_digest equal to the row's recomputed pins.
   *  A store.put row rewrite — self-rehashed or not — cannot mint an
   *  anchor, so tampered state/limits/last_op/last_receipt/applied_ops
   *  is caught here BEFORE any replay shortcut or status projection. */
  private assertAnchorProof(row: PolicyRow): void {
    const events = this.store.listEvents(AUTO_POLICY_ENTITY, row.entity_id);
    const anchors = events.filter((e) => {
      const m = e.metadata as Record<string, unknown> | null;
      return m && m.kind === AUTO_POLICY_EVENT_KIND;
    });
    if (anchors.length !== row.policy_version) {
      fail(
        "FAIL_CLOSED_POLICY_INTEGRITY",
        `anchor count ${anchors.length} != policy_version ${row.policy_version}`,
      );
    }
    let prevTo: string | null = null;
    for (let i = 0; i < anchors.length; i++) {
      const m = anchors[i]!.metadata as Record<string, unknown>;
      if (
        m.policy_version !== i + 1 ||
        typeof m.pins_digest !== "string" ||
        typeof m.to_state !== "string" ||
        (i > 0 && m.from_state !== prevTo)
      ) {
        fail("FAIL_CLOSED_POLICY_INTEGRITY", `anchor chain broken at v${i + 1}`);
      }
      prevTo = String(m.to_state);
    }
    const newest = anchors[anchors.length - 1]!.metadata as Record<string, unknown>;
    if (
      newest.pins_digest !== pinsDigestOf(row) ||
      newest.to_state !== row.state
    ) {
      fail(
        "FAIL_CLOSED_POLICY_INTEGRITY",
        "row diverges from committed anchor pins",
      );
    }
  }

  private mintAnchor(
    id: string,
    action: string,
    fromState: string | null,
    next: PolicyRow,
    idem: string | null,
    opDigest: string | null,
    actor: string,
    objectiveId: string,
  ): void {
    this.store.event({
      entity_type: AUTO_POLICY_ENTITY,
      entity_id: id,
      event_type: `OBJECTIVE_AUTO_POLICY_${action.toUpperCase()}`,
      old_state: fromState,
      new_state: next.state,
      actor: `operator:${actor}`,
      correlation_id: objectiveId,
      metadata: {
        kind: AUTO_POLICY_EVENT_KIND,
        action,
        policy_version: next.policy_version,
        from_state: fromState,
        to_state: next.state,
        idempotency_key: idem,
        op_digest: opDigest,
        pins_digest: pinsDigestOf(next),
      },
    });
  }

  private getObjectiveRow(objectiveId: string) {
    // objectives.get() already runs assertCanonicalRow fail-closed.
    const row = this.objectives.get(objectiveId);
    if (!row || typeof row !== "object") {
      fail("FAIL_CLOSED_POLICY_OBJECTIVE_MISSING", objectiveId);
    }
    return row as Record<string, unknown>;
  }

  private assertOwner(obj: Record<string, unknown>, actor: string): string {
    const owner = String(obj.owner_authority_id ?? "");
    if (actor !== owner) {
      fail(
        "FAIL_CLOSED_POLICY_OWNER",
        `actor is not owner of ${String(obj.objective_id)}`,
      );
    }
    return owner;
  }

  private assertVersion(row: PolicyRow, expected: unknown): void {
    if (!Number.isInteger(expected)) {
      fail("FAIL_CLOSED_POLICY_VERSION_CONFLICT", "policy_version required");
    }
    if (Number(expected) !== row.policy_version) {
      fail(
        "FAIL_CLOSED_POLICY_VERSION_CONFLICT",
        `expected=${Number(expected)} actual=${row.policy_version}`,
      );
    }
  }

  private toStatus(
    objectiveId: string,
    obj: Record<string, unknown>,
    row: PolicyRow | null,
  ): AutoPolicyStatus {
    const reasons: string[] = [];
    let effective = false;
    let termsCurrent = true;
    if (!row) {
      reasons.push("POLICY_NOT_CONFIGURED");
    } else {
      if (row.state !== "ENABLED") reasons.push(`STATE_${row.state}`);
      if (row.state === "ENABLED") {
        // Binding re-proof — the objective may have been amended or its
        // ownership reassigned after enable.
        if (row.business_id !== String(obj.business_id))
          reasons.push("BINDING_BUSINESS_MISMATCH");
        if (row.owner_authority_id !== String(obj.owner_authority_id))
          reasons.push("BINDING_OWNER_MISMATCH");
        // The objective's own integrity-bound `objective_digest` covers
        // identity + terms_version + protected terms — any amend
        // recomputes it, so mismatch ⇒ terms (or owner) changed.
        if (row.terms_digest_binding !== String(obj.objective_digest)) {
          termsCurrent = false;
          reasons.push("TERMS_CHANGED");
        }
        const exp = row.limits?.expires_at;
        if (!exp || Date.parse(exp) <= this.now())
          reasons.push("EXPIRED_OR_NO_EXPIRY");
        // O1 — effective means actual auto eligibility, not merely a
        // valid binding: the objective's own lifecycle must still
        // permit autonomous work (ACTIVE) and its deadline unpassed.
        const objStatus = String(obj.status ?? "");
        if (objStatus !== "ACTIVE") reasons.push(`OBJECTIVE_${objStatus}`);
        const deadline = typeof obj.deadline === "string" ? Date.parse(obj.deadline) : NaN;
        if (!Number.isNaN(deadline) && deadline <= this.now())
          reasons.push("OBJECTIVE_DEADLINE_PASSED");
        effective = reasons.length === 0;
      }
    }
    return {
      objective_id: objectiveId,
      configured: row !== null,
      state: row?.state ?? "DISABLED",
      effective,
      reasons,
      policy_version: row?.policy_version ?? null,
      expires_at: row?.limits?.expires_at ?? null,
      limits: row?.limits ?? null,
      halt: row?.halt ?? null,
      owner_authority_id: String(obj.owner_authority_id),
      business_id: String(obj.business_id),
      driver_ready: false,
      driver_missing: ["AUTO_DRIVER_NOT_INTEGRATED", "COST_BINDING_UNVERIFIED"],
      terms_digest_binding: row?.terms_digest_binding ?? null,
      terms_current: termsCurrent,
    };
  }

  /** Lazy expiry + live binding proof; returns canonical status. */
  evaluate(objectiveId: string): AutoPolicyStatus {
    return this.store.immediate(() => {
      const obj = this.getObjectiveRow(objectiveId);
      let row = this.store.tryGet(
        AUTO_POLICY_ENTITY,
        this.policyId(objectiveId),
      ) as unknown as PolicyRow | null;
      if (row != null) {
        this.assertCanonicalRow(row);
        this.assertAnchorProof(row);
      }
      // Lazy expiry — ENABLED/PAUSED past expires_at commit EXPIRED
      // once, with an event receipt. Never a silent auto-renew.
      if (
        row &&
        (row.state === "ENABLED" || row.state === "PAUSED") &&
        row.limits &&
        Date.parse(row.limits.expires_at) <= this.now()
      ) {
        const expired = { ...row, version: Number(row.version) } as PolicyRow;
        expired.state = "EXPIRED";
        expired.state_reason = `expires_at ${row.limits.expires_at} passed`;
        expired.policy_version = row.policy_version + 1;
        expired.updated_at = utcnow();
        expired.policy_digest = policyDigestOf(expired);
        this.store.put(AUTO_POLICY_ENTITY, expired.entity_id, expired as unknown as Record<string, unknown> & { version: number }, Number(row.version));
        this.mintAnchor(
          expired.entity_id, "expire", row.state, expired,
          null, null, "system:auto-policy", objectiveId,
        );
        row = expired;
      }
      return this.toStatus(objectiveId, obj, row);
    });
  }

  /** Owner-scoped read — a non-owner learns nothing but "forbidden". */
  status(objectiveId: string, actor: string): AutoPolicyStatus {
    return this.store.immediate(() => {
      const obj = this.getObjectiveRow(objectiveId);
      if (!actor || String(actor) !== String(obj.owner_authority_id)) {
        fail("FAIL_CLOSED_POLICY_FORBIDDEN", objectiveId);
      }
      const row = this.store.tryGet(
        AUTO_POLICY_ENTITY,
        this.policyId(objectiveId),
      ) as unknown as PolicyRow | null;
      if (row != null) {
        this.assertCanonicalRow(row);
        this.assertAnchorProof(row);
      }
      // Reuse toStatus but WITHOUT lazy-expiry write — reads never
      // mutate; evaluate() performs expiry, status reports state.
      return this.toStatus(objectiveId, obj, row);
    });
  }

  /** Every mutation: owner-proof inside txn, version CAS, idempotent
   *  replay, canonical receipt. */
  control(input: {
    objective_id: string;
    actor: string;
    action: string;
    /** Expected policy_version — required except first configure
     *  (creates the row at version 0 → policy_version 1). */
    policy_version?: number;
    limits?: unknown;
    idempotency_key: string;
    halt_scope?: unknown;
    halt_reason?: unknown;
  }): AutoPolicyStatus {
    const objectiveId = assertStr("objective_id", input.objective_id);
    const actor = assertStr("actor", input.actor);
    const action = assertStr("action", input.action);
    if (!(AUTO_POLICY_ACTIONS as readonly string[]).includes(action)) {
      fail("FAIL_CLOSED_POLICY_SCHEMA", `action=${action}`);
    }
    const idem = assertStr("idempotency_key", input.idempotency_key);

    return this.store.immediate(() => {
      const obj = this.getObjectiveRow(objectiveId);
      this.assertOwner(obj, actor);
      const id = this.policyId(objectiveId);
      let row = this.store.tryGet(AUTO_POLICY_ENTITY, id) as
        unknown as PolicyRow | null;
      if (row != null) {
        this.assertCanonicalRow(row);
        this.assertAnchorProof(row);
      }

      // Durable idempotent replay across ALL recorded operations (F4):
      // a previously-applied key converges with no new mutation no
      // matter how many operations intervened; same key + different
      // payload fails closed.
      const opDigest = digest({
        action,
        limits: input.limits ?? null,
        halt_scope: input.halt_scope ?? null,
        halt_reason: input.halt_reason ?? null,
      });
      const seen = row?.applied_ops.find((o) => o.key === idem);
      if (seen) {
        if (seen.op_digest === opDigest) {
          return this.toStatus(objectiveId, obj, row);
        }
        fail("FAIL_CLOSED_POLICY_IDEMPOTENCY_CONFLICT", idem);
      }

      // Owner can always reconfigure a DISABLED/absent policy; other
      // actions require the row to exist.
      if (row == null) {
        if (action !== "configure") {
          fail("FAIL_CLOSED_POLICY_TRANSITION", `no policy for ${action}`);
        }
        row = {
          entity_type: AUTO_POLICY_ENTITY,
          entity_id: id,
          schema_version: AUTO_POLICY_SCHEMA,
          objective_id: objectiveId,
          business_id: String(obj.business_id),
          owner_authority_id: String(obj.owner_authority_id),
          state: "DISABLED",
          state_reason: null,
          policy_version: 0,
          limits: null,
          terms_digest_binding: null,
          applied_ops: [],
          last_op: null,
          last_receipt: null,
          halt: null,
          created_at: utcnow(),
          updated_at: utcnow(),
          version: 0,
          policy_digest: "",
        };
      } else {
        this.assertVersion(row, input.policy_version);
      }

      const allowed = TRANSITIONS[action];
      if (!allowed.includes(row.state)) {
        fail(
          "FAIL_CLOSED_POLICY_TRANSITION",
          `${action} not allowed from ${row.state}`,
        );
      }

      const next = { ...row } as PolicyRow;
      next.policy_version = row.policy_version + 1;
      next.updated_at = utcnow();

      switch (action) {
        case "configure": {
          // DISABLED or EXPIRED → (re)arm with a fresh finite limit
          // set. EXPIRED reconfigure lands back on DISABLED — an
          // expired window never silently re-enables. A window that is
          // already lapsed is not a finite authorization — reject it
          // here rather than at some later transition.
          const limits = assertLimits(input.limits);
          if (Date.parse(limits.expires_at) <= this.now()) {
            fail("FAIL_CLOSED_POLICY_LIMITS", "expires_at already lapsed");
          }
          next.limits = limits;
          next.state = "DISABLED";
          next.state_reason = null;
          break;
        }
        case "enable": {
          if (!row.limits) {
            fail("FAIL_CLOSED_POLICY_LIMITS", "configure limits first");
          }
          if (Date.parse(row.limits.expires_at) <= this.now()) {
            fail("FAIL_CLOSED_POLICY_LIMITS", "limits already expired");
          }
          next.state = "ENABLED";
          // Capture objective terms AT enable — any later amend bumps
          // terms_version → digest mismatch → effective=false.
          next.terms_digest_binding = String(obj.objective_digest);
          next.halt = null;
          break;
        }
        case "pause":
          next.state = "PAUSED";
          break;
        case "resume":
          // Stale resume never resurrects an expired/revoked window —
          // PAUSED→ENABLED still requires limits unexpired.
          if (!row.limits || Date.parse(row.limits.expires_at) <= this.now()) {
            fail("FAIL_CLOSED_POLICY_LIMITS", "window expired — reconfigure");
          }
          next.state = "ENABLED";
          break;
        case "disable":
          next.state = "DISABLED";
          next.terms_digest_binding = null;
          break;
        case "revoke":
          next.state = "REVOKED";
          next.terms_digest_binding = null;
          next.halt = null;
          break;
        case "halt": {
          const scope = input.halt_scope === undefined ? "OBJECTIVE" : input.halt_scope;
          if (scope !== "OBJECTIVE") {
            fail(
              "FAIL_CLOSED_POLICY_HALT_SCOPE",
              "P15.10-A supports OBJECTIVE-scope halt only",
            );
          }
          next.state = "HALTED";
          next.halt = {
            scope: "OBJECTIVE",
            actor,
            at: utcnow(),
            reason:
              input.halt_reason === undefined
                ? "operator halt"
                : assertStr("halt_reason", input.halt_reason),
          };
          break;
        }
        case "reset_halt":
          next.state = "DISABLED";
          next.state_reason = `halt reset by ${actor}`;
          next.terms_digest_binding = null;
          next.halt = null;
          break;
      }

      const receipt = {
        action,
        objective_id: objectiveId,
        from_state: row.state,
        to_state: next.state,
        policy_version: next.policy_version,
        actor,
        at: next.updated_at,
      };
      next.last_op = { key: idem, action, op_digest: opDigest };
      next.last_receipt = receipt;
      next.applied_ops = [...row.applied_ops, { key: idem, action, op_digest: opDigest }];
      next.policy_digest = policyDigestOf(next);

      this.store.put(AUTO_POLICY_ENTITY, id, next as unknown as Record<string, unknown> & { version: number }, Number(row.version));
      this.mintAnchor(
        id, action, row.state, next, idem, opDigest, actor, objectiveId,
      );
      return this.toStatus(objectiveId, obj, next);
    });
  }
}
