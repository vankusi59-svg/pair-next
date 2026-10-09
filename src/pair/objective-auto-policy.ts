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
  /** Last idempotent op — replay converges to its receipt. */
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
    policy_version: r.policy_version,
    limits: r.limits,
    terms_digest_binding: r.terms_digest_binding,
    halt: r.halt,
  });
}

export class ObjectiveAutoPolicyService {
  constructor(
    private readonly store: PairEvidenceStore,
    private readonly objectives: ObjectiveAuthorityService,
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
    if (
      p.policy_digest !==
      policyDigestOf({ ...(p as unknown as PolicyRow) })
    ) {
      fail("FAIL_CLOSED_POLICY_INTEGRITY", "policy_digest mismatch");
    }
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
        if (!exp || Date.parse(exp) <= Date.now())
          reasons.push("EXPIRED_OR_NO_EXPIRY");
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
      if (row != null) this.assertCanonicalRow(row);
      // Lazy expiry — ENABLED/PAUSED past expires_at commit EXPIRED
      // once, with an event receipt. Never a silent auto-renew.
      if (
        row &&
        (row.state === "ENABLED" || row.state === "PAUSED") &&
        row.limits &&
        Date.parse(row.limits.expires_at) <= Date.now()
      ) {
        const expired = { ...row, version: Number(row.version) } as PolicyRow;
        expired.state = "EXPIRED";
        expired.state_reason = `expires_at ${row.limits.expires_at} passed`;
        expired.policy_version = row.policy_version + 1;
        expired.updated_at = utcnow();
        expired.policy_digest = policyDigestOf(expired);
        this.store.put(AUTO_POLICY_ENTITY, expired.entity_id, expired as unknown as Record<string, unknown> & { version: number }, Number(row.version));
        this.store.event({
          entity_type: AUTO_POLICY_ENTITY,
          entity_id: expired.entity_id,
          event_type: "OBJECTIVE_AUTO_POLICY_EXPIRED",
          old_state: row.state,
          new_state: "EXPIRED",
          actor: `system:auto-policy`,
          metadata: { objective_id: objectiveId },
        });
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
      if (row != null) this.assertCanonicalRow(row);
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
      if (row != null) this.assertCanonicalRow(row);

      // Idempotent replay: same key + same operation → the recorded
      // receipt; same key + different payload → typed conflict.
      const opDigest = digest({
        action,
        limits: input.limits ?? null,
        halt_scope: input.halt_scope ?? null,
        halt_reason: input.halt_reason ?? null,
      });
      if (row?.last_op && row.last_op.key === idem) {
        if (row.last_op.op_digest === opDigest && row.last_receipt) {
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
          // expired window never silently re-enables.
          next.limits = assertLimits(input.limits);
          next.state = "DISABLED";
          next.state_reason = null;
          break;
        }
        case "enable": {
          if (!row.limits) {
            fail("FAIL_CLOSED_POLICY_LIMITS", "configure limits first");
          }
          if (Date.parse(row.limits.expires_at) <= Date.now()) {
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
          if (!row.limits || Date.parse(row.limits.expires_at) <= Date.now()) {
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
      next.policy_digest = policyDigestOf(next);

      this.store.put(AUTO_POLICY_ENTITY, id, next as unknown as Record<string, unknown> & { version: number }, Number(row.version));
      this.store.event({
        entity_type: AUTO_POLICY_ENTITY,
        entity_id: id,
        event_type: `OBJECTIVE_AUTO_POLICY_${action.toUpperCase()}`,
        old_state: row === undefined ? null : row.state,
        new_state: next.state,
        actor: `operator:${actor}`,
        correlation_id: objectiveId,
        metadata: {
          policy_version: next.policy_version,
          idempotency_key: idem,
        },
      });
      return this.toStatus(objectiveId, obj, next);
    });
  }
}
