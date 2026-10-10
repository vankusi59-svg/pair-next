/** P15.10-D — Objective KPI verification service (canonical writer seam).
 *
 *  Closes the gap observed in the P15.10-C operation test: missions
 *  completed, artifacts were canonically ACCEPTED, yet KPI stayed
 *  UNVERIFIED because PAIR had no authority contract for automated
 *  progress. This service adds that contract without weakening P15.1:
 *
 *   - owner opt-in grant (`objective_kpi_auto_authorization`, KVA_) scopes
 *     authority to exactly {business, objective, kpi, rule} with a required
 *     expiry and a terms_version pin. Default OFF — no grant, no write.
 *   - `verifyAndRecord` re-derives every fact inside ONE transaction from
 *     canonical rows only: workstream child folded DONE + bound mission
 *     proven COMPLETED + ≥1 ACCEPTED artifact attributed through that
 *     mission. Names, paths, executor self-reports and LLM opinions are
 *     never evidence.
 *   - On success it writes an immutable `kpi_verification_receipt` (KVR_)
 *     and calls the EXISTING `objectives.recordProgress` seam with verifier
 *     `kpi-verifier:<authorization_id>` — which independently re-validates
 *     grant+receipt inside the same transaction
 *     (objective-kpi-verifier-authority.ts). No owner impersonation.
 *
 *  Bounded by construction: verification runs at an explicit call site
 *  (once per operating pass / one operator call), never a background loop.
 */

import { IntegrityError, NotFoundError } from "./errors.js";
import { digest, newId, utcnow } from "./canonical.js";
import type { PairEvidenceStore } from "./store.js";
import type { ObjectiveAuthorityService } from "./objective-authority.js";
import type { ObjectiveWorkstreamService } from "./objective-workstream.js";
import type { BusinessLayer } from "./business.js";
import { ArtifactAuthority } from "./artifact-authority.js";
import { assertCanonicalMissionCompletion } from "./work-completion.js";
import {
  KPI_AUTH_ENTITY,
  KPI_RECEIPT_ENTITY,
  KPI_VERIFIER_KIND,
  KPI_VERIFIER_WRITER,
  KPI_VERIFIER_SCHEMA,
  KPI_RECEIPT_SCHEMA,
  KPI_AUTH_STATES,
  type KpiAuthState,
  kpiAuthEffectiveReason,
  kpiAuthFail,
  kpiAuthNotFound,
  kpiEvidenceKey,
  kpiReceiptByDigest,
  kpiReceiptDigest,
  normalizeKpiVerifyRule,
  type KpiVerifyRule,
} from "./objective-kpi-verifier-authority.js";

type Row = Record<string, unknown> & { version: number };

const TERMINAL_OBJECTIVE_STATUSES = new Set(["ACHIEVED", "INFEASIBLE", "CANCELLED", "EXPIRED"]);

export interface VerifiedUnit {
  workstream_key: string;
  work_item_id: string;
  mission_id: string;
  artifact_ids: string[];
}

export interface KpiVerifyOutcome {
  authorization_id: string;
  kpi_id: string;
  outcome:
    | "PROGRESS_RECORDED"
    | "REPLAYED"
    | "UNVERIFIED"
    | "AUTH_INEFFECTIVE";
  reason?: string;
  receipt_id?: string;
  evidence_key?: string;
  value?: number;
  verified_units?: VerifiedUnit[];
}

export class ObjectiveKpiVerificationService {
  constructor(
    private readonly deps: {
      store: PairEvidenceStore;
      objectives: ObjectiveAuthorityService;
      workstreams: ObjectiveWorkstreamService;
      business: BusinessLayer;
      /** F1 — the canonical artifact verification seam. ACCEPTED row
       *  state is never trusted: every candidate artifact is re-proven
       *  (acceptance history + canonical shape + retained CAS bytes)
       *  through this authority inside the same transaction. */
      artifacts: ArtifactAuthority;
      now?: () => number;
    },
  ) {}

  private get store(): PairEvidenceStore {
    return this.deps.store;
  }
  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  // ------------------------------------------------------------------
  // Owner control plane (grant / revoke / disable / status)
  // ------------------------------------------------------------------

  private assertOwner(objective: Row, actor: string): void {
    if (!actor) {
      throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "kpiVerification");
    }
    if (actor !== String(objective.owner_authority_id)) {
      kpiAuthFail(`actor ${actor} is not the objective owner`);
    }
  }

  grant(objectiveId: string, input: {
    actor: string;
    kpi_id: string;
    rule: unknown;
    expires_at: string;
    idempotency_key: string;
  }): Row {
    if (typeof input.idempotency_key !== "string" || !input.idempotency_key.trim()) {
      throw new IntegrityError("FAIL_CLOSED_POLICY_SCHEMA", "idempotency_key required");
    }
    const objective = this.deps.objectives.get(objectiveId); // strict P15.1 read
    this.assertOwner(objective, input.actor);
    const rule = normalizeKpiVerifyRule(input.rule);
    const exp = Date.parse(String(input.expires_at));
    if (!Number.isFinite(exp) || exp <= this.now()) {
      kpiAuthFail("expires_at must be a future timestamp");
    }
    const kpis = (objective.kpis ?? []) as Array<Record<string, unknown>>;
    const kpi = kpis.find((k) => String(k.kpi_id) === input.kpi_id);
    if (!kpi) {
      throw new NotFoundError(`objective ${objectiveId} kpi ${input.kpi_id}`);
    }
    if (TERMINAL_OBJECTIVE_STATUSES.has(String(objective.status))) {
      kpiAuthFail(`objective ${objectiveId} status ${String(objective.status)} is terminal`);
    }
    return this.store.immediate(() => {
      // F2 — durable idempotency, resolved INSIDE the transaction so a
      // retried/replayed request can never mint a second grant nor undo
      // a revoke: same key + same semantics returns the stored row
      // (whatever its state); same key + different semantics fails
      // closed; concurrent duplicates converge on the first mint.
      const ruleDigest = digest(rule);
      for (const prior of this.store.list<Row>(KPI_AUTH_ENTITY)) {
        if (
          String(prior.objective_id) === objectiveId &&
          String(prior.dedup_key) === input.idempotency_key
        ) {
          const sameSemantics =
            String(prior.business_id) === String(objective.business_id) &&
            String(prior.kpi_id) === String(input.kpi_id) &&
            String(prior.rule_digest) === ruleDigest &&
            String(prior.expires_at) === new Date(exp).toISOString() &&
            String(prior.owner_authority_id) === String(objective.owner_authority_id) &&
            String(prior.created_by) === input.actor;
          if (!sameSemantics) {
            kpiAuthFail(
              `idempotency_key ${input.idempotency_key} replays with different semantics`,
            );
          }
          return prior;
        }
      }
      // ONE enabled grant per (objective,kpi) — competing measurements on
      // the same KPI are structurally impossible.
      for (const g of this.store.list<Row>(KPI_AUTH_ENTITY)) {
        if (
          String(g.objective_id) === objectiveId &&
          String(g.kpi_id) === String(input.kpi_id) &&
          String(g.state) === "ENABLED"
        ) {
          kpiAuthFail(`kpi ${input.kpi_id} already has an ENABLED authorization ${String(g.authorization_id)}`);
        }
      }
      const id = newId("KVA");
      const row: Row = {
        entity_type: KPI_AUTH_ENTITY,
        entity_id: id,
        schema_version: KPI_VERIFIER_SCHEMA,
        authorization_id: id,
        business_id: String(objective.business_id),
        objective_id: objectiveId,
        kpi_id: String(input.kpi_id),
        owner_authority_id: String(objective.owner_authority_id),
        rule,
        rule_digest: ruleDigest,
        progress_value: rule.progress_value,
        objective_terms_version: Number(objective.terms_version),
        expires_at: new Date(exp).toISOString(),
        state: "ENABLED" satisfies KpiAuthState,
        state_reason: null,
        created_by: input.actor,
        dedup_key: input.idempotency_key,
        created_at: utcnow(),
        updated_at: utcnow(),
        version: 0,
      };
      row.authorization_digest = digest({
        schema: KPI_VERIFIER_SCHEMA,
        authorization_id: id,
        objective_id: objectiveId,
        kpi_id: String(input.kpi_id),
        rule_digest: row.rule_digest,
        terms: row.objective_terms_version,
      });
      const saved = this.store.put(KPI_AUTH_ENTITY, id, row, 0);
      this.store.event({
        entity_type: KPI_AUTH_ENTITY,
        entity_id: id,
        event_type: "KPI_AUTO_AUTHORIZATION_GRANTED",
        actor: input.actor,
        metadata: {
          objective_id: objectiveId,
          kpi_id: input.kpi_id,
          rule_digest: row.rule_digest,
          expires_at: row.expires_at,
        },
      });
      return saved;
    });
  }

  /** Revoke/disable — either action permanently blocks the grant (no
   *  re-enable of the same row; a new grant row is required). */
  control(objectiveId: string, authorizationId: string, input: {
    actor: string;
    action: "revoke" | "disable";
    idempotency_key: string;
  }): Row {
    const objective = this.deps.objectives.get(objectiveId);
    this.assertOwner(objective, input.actor);
    if (!["revoke", "disable"].includes(input.action)) {
      throw new IntegrityError("FAIL_CLOSED_POLICY_SCHEMA", `action ${String(input.action)}`);
    }
    return this.store.immediate(() => {
      const grant = this.store.get(KPI_AUTH_ENTITY, authorizationId);
      if (String(grant.objective_id) !== objectiveId) {
        kpiAuthFail(`authorization ${authorizationId} does not bind objective ${objectiveId}`);
      }
      if (grant.state !== "ENABLED") {
        return grant; // already closed — idempotent
      }
      grant.state = (input.action === "revoke" ? "REVOKED" : "DISABLED") as KpiAuthState;
      grant.state_reason = `${input.action.toUpperCase()} by ${input.actor}`;
      grant.updated_at = utcnow();
      const saved = this.store.put(KPI_AUTH_ENTITY, authorizationId, grant, Number(grant.version));
      this.store.event({
        entity_type: KPI_AUTH_ENTITY,
        entity_id: authorizationId,
        event_type: `KPI_AUTO_AUTHORIZATION_${grant.state}`,
        actor: input.actor,
        metadata: { objective_id: objectiveId, kpi_id: grant.kpi_id },
      });
      return saved;
    });
  }

  status(objectiveId: string, actor: string): Record<string, unknown> {
    const objective = this.deps.objectives.get(objectiveId);
    this.assertOwner(objective, actor);
    const now = this.now();
    const grants = this.store
      .list<Row>(KPI_AUTH_ENTITY)
      .filter((g) => String(g.objective_id) === objectiveId)
      .map((g) => ({
        authorization_id: g.authorization_id,
        kpi_id: g.kpi_id,
        state: g.state,
        state_reason: g.state_reason,
        expires_at: g.expires_at,
        effective: kpiAuthEffectiveReason(g, objective, String(g.kpi_id), now) === null,
        ineffective_reason: kpiAuthEffectiveReason(g, objective, String(g.kpi_id), now),
        rule: g.rule,
        objective_terms_version: g.objective_terms_version,
        created_at: g.created_at,
      }));
    const receipts = this.store
      .list<Row>(KPI_RECEIPT_ENTITY)
      .filter((r) => String(r.objective_id) === objectiveId)
      .map((r) => ({
        receipt_id: r.receipt_id,
        authorization_id: r.authorization_id,
        kpi_id: r.kpi_id,
        progress_value: r.progress_value,
        evidence_key: r.evidence_key,
        verified_count: Array.isArray(r.verified_units) ? (r.verified_units as unknown[]).length : 0,
        created_at: r.created_at,
      }));
    return { objective_id: objectiveId, grants, receipts };
  }

  // ------------------------------------------------------------------
  // Canonical evidence attribution (re-derived, never trusted)
  // ------------------------------------------------------------------

  /** One verified deliverable unit per workstream child:
   *   binding scope + child folded DONE + canonical bound mission
   *   COMPLETED + ≥1 artifact ACCEPTED attributed to that mission through
   *   its governed task. Anything short removes the key from the set —
   *   there is no partial credit path here. */
  private verifiedUnits(objective: Row): VerifiedUnit[] {
    const objectiveId = String(objective.objective_id);
    const businessId = String(objective.business_id);
    const binding = this.deps.workstreams.getBinding(objectiveId);
    if (!binding) return [];
    if (
      String(binding.business_id) !== businessId ||
      String(binding.objective_id) !== objectiveId
    ) {
      kpiAuthFail(`binding ${String(binding.binding_id)} scope mismatch for ${objectiveId}`);
    }
    const out: VerifiedUnit[] = [];
    const workstreams = (binding.workstreams ?? []) as Array<Record<string, unknown>>;
    // Delegated-child resolution: the workstream row points at the
    // workstream work item; the canonical WAL pins the child that the
    // bound mission+fold actually moves. Both are scope-checked.
    const wals = this.store.list<Row>("workforce_allocation");
    const seen = new Set<string>();
    for (const w of workstreams) {
      const key = String(w.workstream_key ?? "");
      const wsWorkItemId = String(w.work_item_id ?? "");
      if (!key || !wsWorkItemId || seen.has(key)) continue;
      seen.add(key);
      const wal = wals.find(
        (a) => String(a.workstream_work_item_id) === wsWorkItemId);
      if (!wal || String(wal.business_id ?? "") !== businessId) continue;
      const workItemId = String(wal.delegated_child_work_item_id ?? "");
      if (!workItemId) continue;
      let child: Row | null = null;
      try {
        child = this.store.get<Row>("work_item", workItemId);
      } catch (err) {
        if (err instanceof NotFoundError) continue;
        throw err;
      }
      // Scope proof: binding.objective_id already pins the objective —
      // the delegated child only needs fold status + business scope; its
      // own objective_id field is legitimately null on real chains.
      if (
        String(child.status) !== "DONE" ||
        String(child.business_id) !== businessId
      ) {
        continue;
      }
      const mission = this.deps.business.boundMissionForWorkItem(child);
      if (!mission) continue;
      // Canonical completion proof — replays mission/runtime evidence,
      // never trusts the status field.
      assertCanonicalMissionCompletion(this.store, mission);
      const wob = this.store.tryGet<Row>(
        "work_open_binding",
        String(mission.bound_open_id ?? ""),
      );
      if (
        !wob ||
        String(wob.work_item_id) !== String(child.work_item_id) ||
        String(wob.business_id) !== businessId
      ) {
        kpiAuthFail(
          `mission ${String(mission.mission_id)} binding lineage inconsistent for ${workItemId}`,
        );
      }
      // ≥1 ACCEPTED artifact attributed to THIS mission via its governed
      // task — rows carry mission_id directly; cross-mission rows are
      // structurally excluded. F1: ACCEPTED row state alone is not
      // proof — each candidate is re-verified through the canonical
      // artifact authority (acceptance history + canonical shape +
      // retained CAS bytes verified NOW). A deleted/tampered blob or a
      // row drifted from its acceptance facts fails the whole read
      // closed rather than silently de-scoping the unit.
      const artifactIds = this.store
        .list<Row>("artifact")
        .filter(
          (a) =>
            String(a.state) === "ACCEPTED" &&
            String(a.mission_id) === String(mission.mission_id) &&
            this.store
              .tryGet<Row>("governed_task", String(a.governed_task_id ?? ""))
              ?.mission_id === String(mission.mission_id),
        )
        .map((a) => String(a.artifact_id))
        .sort();
      for (const artifactId of artifactIds) {
        const a = this.store.get<Row>("artifact", artifactId);
        this.deps.artifacts.verifyArtifactForConsumption(artifactId, {
          execution_id: String(a.execution_id),
          mission_id: String(mission.mission_id),
          governed_task_id: String(a.governed_task_id),
          producer_executor_id: String(a.producer_executor_id),
          sha256: String(a.sha256),
          byte_size: Number(a.byte_size),
          logical_name: String(a.logical_name),
        });
      }
      if (artifactIds.length === 0) continue;
      out.push({
        workstream_key: key,
        work_item_id: workItemId,
        mission_id: String(mission.mission_id),
        artifact_ids: artifactIds,
      });
    }
    return out;
  }

  private ruleSatisfied(rule: KpiVerifyRule, units: VerifiedUnit[]): boolean {
    const keys = new Set(units.map((u) => u.workstream_key));
    if (rule.required_count !== undefined && units.length < rule.required_count) {
      return false;
    }
    if (rule.required_keys) {
      for (const k of rule.required_keys) if (!keys.has(k)) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------
  // verifyAndRecord — atomic: revalidate grant+objective, re-derive
  // evidence, mint receipt, then recordProgress re-validates again.
  // ------------------------------------------------------------------

  /** One bounded verification attempt for a single grant. Throws
   *  IntegrityError on canonical corruption; returns a status record
   *  otherwise (UNVERIFIED means evidence does not satisfy the rule yet). */
  private verifyGrant(objectiveId: string, grantId: string): KpiVerifyOutcome {
    const now = this.now();
    return this.store.immediate(() => {
      const objective = this.deps.objectives.get(objectiveId); // strict re-read
      const grant = this.store.get(KPI_AUTH_ENTITY, grantId);
      const ineffective = kpiAuthEffectiveReason(grant, objective, String(grant.kpi_id), now);
      if (ineffective) {
        return {
          authorization_id: grantId,
          kpi_id: String(grant.kpi_id),
          outcome: "AUTH_INEFFECTIVE",
          reason: ineffective,
        };
      }
      const units = this.verifiedUnits(objective);
      const rule = grant.rule as KpiVerifyRule;
      if (!this.ruleSatisfied(rule, units)) {
        return {
          authorization_id: grantId,
          kpi_id: String(grant.kpi_id),
          outcome: "UNVERIFIED",
          reason: `required bundle not satisfied (${units.length} verified unit(s))`,
          verified_units: units,
        };
      }
      const progressValue = Number(rule.progress_value ?? grant.progress_value ?? 1);
      // Replay dedup — an identical measurement (same grant, same units,
      // same terms, same value) already produced a receipt+progress:
      // returning REPLAYED keeps the ledger idempotent and prevents
      // double-counting, two racing verifiers included.
      const priorDigest = kpiReceiptDigest({
        authorization_id: grantId,
        objective_id: objectiveId,
        business_id: String(objective.business_id),
        kpi_id: String(grant.kpi_id),
        objective_terms_version: Number(objective.terms_version),
        rule_digest: String(grant.rule_digest),
        verified_units: units,
        progress_value: progressValue,
      });
      const prior = kpiReceiptByDigest(this.store, priorDigest);
      if (prior) {
        return {
          authorization_id: grantId,
          kpi_id: String(grant.kpi_id),
          outcome: "REPLAYED",
          receipt_id: String(prior.receipt_id),
          evidence_key: String(prior.evidence_key),
          value: progressValue,
          verified_units: units,
        };
      }
      // Revalidate rule/contract version at commit time — a grant edited
      // between chain eval and commit still passes through the same
      // transaction here (SQLite serializes writers).
      const receiptId = newId("KVR");
      const receipt: Row = {
        entity_type: KPI_RECEIPT_ENTITY,
        entity_id: receiptId,
        schema_version: KPI_RECEIPT_SCHEMA,
        receipt_id: receiptId,
        authorization_id: grantId,
        objective_id: objectiveId,
        business_id: String(objective.business_id),
        kpi_id: String(grant.kpi_id),
        objective_terms_version: Number(objective.terms_version),
        rule_digest: String(grant.rule_digest),
        verified_units: units,
        progress_value: progressValue,
        evidence_key: kpiEvidenceKey(grantId, receiptId),
        produced_by: KPI_VERIFIER_WRITER,
        created_at: utcnow(),
        version: 0,
      };
      receipt.receipt_digest = kpiReceiptDigest(receipt);
      const evidenceKey = String(receipt.evidence_key);
      // Idempotent replay: an identical prior receipt+progress for the
      // same units is a no-op; a same-key different-content claim dies in
      // the P15.1 ledger conflict check inside recordProgress.
      this.store.put(KPI_RECEIPT_ENTITY, receiptId, receipt, 0);
      this.store.event({
        entity_type: KPI_RECEIPT_ENTITY,
        entity_id: receiptId,
        event_type: "KPI_VERIFICATION_RECEIPT",
        actor: KPI_VERIFIER_WRITER,
        metadata: {
          authorization_id: grantId,
          objective_id: objectiveId,
          kpi_id: grant.kpi_id,
          verified_count: units.length,
        },
      });
      const progress = this.deps.objectives.recordProgress(objectiveId, {
        business_id: String(objective.business_id),
        kpi_id: String(grant.kpi_id),
        value: progressValue,
        evidence: {
          evidence_key: evidenceKey,
          verifier: `${KPI_VERIFIER_KIND}:${grantId}`,
          source: `kpi-verification:${String(rule.rule_type)}`,
        },
        note: `auto-verified ${units.length} deliverable unit(s) under ${grantId}`,
        actor: KPI_VERIFIER_WRITER,
      });
      const wrote = (progress.evidence_refs as Array<Record<string, unknown>>).some(
        (e) => String(e.evidence_key) === evidenceKey,
      );
      return {
        authorization_id: grantId,
        kpi_id: String(grant.kpi_id),
        outcome: wrote ? "PROGRESS_RECORDED" : "REPLAYED",
        receipt_id: receiptId,
        evidence_key: evidenceKey,
        value: progressValue,
        verified_units: units,
      };
    });
  }

  /** Scan every grant for this objective once — bounded to the grants
   *  present, never a loop. Called once per operating pass / explicit
   *  operator request. */
  advance(objectiveId: string): KpiVerifyOutcome[] {
    const grants = this.store
      .list<Row>(KPI_AUTH_ENTITY)
      .filter((g) => String(g.objective_id) === objectiveId);
    const out: KpiVerifyOutcome[] = [];
    for (const g of grants) {
      out.push(this.verifyGrant(objectiveId, String(g.authorization_id)));
    }
    return out;
  }
}
