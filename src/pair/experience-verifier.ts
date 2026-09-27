/**
 * Deterministic experience verifier + promotion boundary.
 *
 * Promotion to QUALIFIED / ACTIVE is gated by `verify()` — a fixed checklist
 * over canonical evidence. The verifier is a distinct component: the extractor
 * that produced a candidate can never verify it (self-promotion is rejected).
 * verify() returns a persisted verifier_result object; callers then drive
 * ExperienceService.qualify/activate with it.
 */

import { experienceDigest } from "./experience.js";
import type { ExperienceService } from "./experience.js";
import { NotFoundError, IntegrityError } from "./errors.js";
import type { PairControlPlane } from "./service.js";
import { utcnow } from "./canonical.js";

/** Origins allowed to reach ACTIVE advisory weight in production. */
const ACTIVE_ELIGIBLE_ORIGINS = new Set([
  "REAL_EXECUTION",
  "LIVE_PROBE",
  "DETERMINISTIC_TEST",
  "OPERATOR_ASSERTION",
]);

/** Types that imply a positive capability/routing claim — their subjects must
 *  still be governed-qualified entities (not revoked/removed/unqualified). */
const SUBJECT_QUALITY_TYPES = new Set([
  "ROUTING_PRIOR",
  "PROVIDER_MODEL_OBSERVATION",
  "EXECUTOR_OBSERVATION",
]);

const DEFAULT_MIN_SUPPORT: Record<string, number> = {
  ROUTING_PRIOR: 2,
};

export interface VerifyCheck {
  check: string;
  pass: boolean;
  detail: string;
}

export class ExperienceVerifier {
  constructor(
    private readonly service: PairControlPlane,
    private readonly experience: ExperienceService,
  ) {}

  private get store() {
    return this.service.store;
  }

  private refMentions(entity: Record<string, unknown>, needles: string[]): boolean {
    if (!needles.length) return true;
    const hay = JSON.stringify(entity);
    return needles.some((n) => n && hay.includes(n));
  }

  /** Reject/quarantine signals derived from poisoned or unverifiable claims. */
  private poisonChecks(
    exp: Record<string, unknown>,
    target: string,
  ): VerifyCheck[] {
    const checks: VerifyCheck[] = [];
    const origin = String(exp.evidence_origin ?? "OPERATOR_ASSERTION");
    checks.push({
      check: "ORIGIN_ALLOWED",
      pass:
        target !== "ACTIVE" ||
        (ACTIVE_ELIGIBLE_ORIGINS.has(origin) &&
          !(origin === "SIMULATED_FIXTURE" && String(exp.type) === "ROUTING_PRIOR")),
      detail: `origin=${origin}`,
    });
    const scope = (exp.compatibility_scope as Record<string, unknown>) ?? {};
    if (SUBJECT_QUALITY_TYPES.has(String(exp.type)) && exp.outcome === "SUCCESS") {
      for (const eid of (scope.executors as string[]) ?? []) {
        const rec = this.store.tryGet("executor", eid);
        const meta = (rec?.metadata as Record<string, unknown>) ?? {};
        const q = String(
          meta.qualification_state ??
            (meta.qualification as Record<string, unknown>)?.state ??
            rec?.qualification_state ??
            "",
        );
        // Positive capability claims need a governed-qualified executor.
        checks.push({
          check: "EXECUTOR_QUALIFIED",
          pass: rec != null && q === "QUALIFIED",
          detail: `${eid}:${q || "absent"}`,
        });
      }
      const providerId = scope.provider ? String(scope.provider) : null;
      if (providerId) {
        const prov = this.store.tryGet("provider", providerId);
        const lifecycle = String(prov?.lifecycle_state ?? "");
        const revoked =
          prov == null ||
          ["REMOVED", "REVOKED", "BLOCKED"].includes(lifecycle) ||
          (prov.conditions as string[])?.includes("BLOCKED") === true ||
          !["QUALIFIED", "MODEL_DISCOVERY_ELIGIBLE"].includes(lifecycle);
        checks.push({
          check: "PROVIDER_QUALIFIED_NOT_REVOKED",
          pass: !revoked,
          detail: `${providerId}:${lifecycle || "absent"}`,
        });
      }
      const modelRef = scope.model ? String(scope.model) : null;
      if (modelRef) {
        const entries = this.store.list("model_entry");
        const entry = entries.find(
          (m) => m.model_id === modelRef || m.model_entry_id === modelRef,
        );
        const bad =
          entry == null ||
          !["QUALIFIED"].includes(String(entry.lifecycle_state)) ||
          ["REMOVED", "BLOCKED"].includes(String(entry.lifecycle_state));
        checks.push({
          check: "MODEL_QUALIFIED_NOT_REMOVED",
          pass: !bad,
          detail: `${modelRef}:${String(entry?.lifecycle_state ?? "absent")}`,
        });
      }
    }
    return checks;
  }

  /**
   * Run the full verification checklist. `target` is the intended status
   * (QUALIFIED or ACTIVE) — ACTIVE adds origin + min-support gates.
   */
  verify(
    expId: string,
    opts: { verifier_id: string; target: "QUALIFIED" | "ACTIVE" },
  ): { pass: boolean; checks: VerifyCheck[]; verifier_result: Record<string, unknown> } {
    const checks: VerifyCheck[] = [];
    let exp: Record<string, unknown> | null = null;
    try {
      exp = this.experience.get(expId);
    } catch {
      checks.push({ check: "EXPERIENCE_EXISTS", pass: false, detail: expId });
      return this.result(expId, opts, checks);
    }

    // 1. evidence refs present
    const refs = (exp.source_evidence_refs as string[]) ?? [];
    checks.push({
      check: "EVIDENCE_REFS_PRESENT",
      pass: refs.length > 0,
      detail: `${refs.length}`,
    });

    // 2. every ref resolves AND survives verify-on-read (tamper → IntegrityError)
    let refsOk = refs.length > 0;
    let refsDetail = "";
    for (const r of refs) {
      const [t, id] = String(r).split(":", 2);
      try {
        if (!t || !id) throw new NotFoundError(r);
        this.store.get(t, id);
      } catch (e) {
        refsOk = false;
        refsDetail =
          e instanceof IntegrityError ? `${r}:TAMPERED` : `${r}:MISSING`;
        break;
      }
    }
    checks.push({ check: "EVIDENCE_REFS_RESOLVE", pass: refsOk, detail: refsDetail });

    // 3. relevance — a resolved ref must mention the claimed subject
    const scope = (exp.compatibility_scope as Record<string, unknown>) ?? {};
    const subjects = [
      ...((scope.executors as string[]) ?? []),
      scope.provider ? String(scope.provider) : "",
      scope.model ? String(scope.model) : "",
      ...(((exp.payload as Record<string, unknown>)?.executor_id
        ? [String((exp.payload as Record<string, unknown>).executor_id)]
        : []) as string[]),
      ...(((exp.payload as Record<string, unknown>)?.plan_shape
        ? [String((exp.payload as Record<string, unknown>).plan_shape)]
        : []) as string[]),
    ].filter(Boolean);
    let relevant = true;
    if (subjects.length && refsOk) {
      relevant = false;
      for (const r of refs) {
        const [t, id] = String(r).split(":", 2);
        const entity = this.store.tryGet(t, id);
        if (entity && this.refMentions(entity, subjects)) {
          relevant = true;
          break;
        }
      }
    }
    checks.push({
      check: "EVIDENCE_RELEVANT",
      pass: relevant,
      detail: subjects.join(","),
    });

    // 4. compatibility scope defined
    checks.push({
      check: "SCOPE_DEFINED",
      pass: Object.keys(scope).length > 0 || exp.type === "FAILURE_SIGNATURE",
      detail: `${Object.keys(scope).length} keys`,
    });

    // 5. learning firewall
    checks.push({
      check: "PERMISSION_EFFECT_NONE",
      pass: String(exp.permission_effect ?? "NONE") === "NONE",
      detail: String(exp.permission_effect),
    });

    // 6. no self-promotion — verifier must differ from the extractor
    checks.push({
      check: "NOT_SELF_PROMOTED",
      pass:
        opts.verifier_id !== String(exp.extracted_by) &&
        opts.verifier_id !== "EXPERIENCE_SERVICE" &&
        opts.verifier_id !== "EXPERIENCE_EXTRACTION" &&
        opts.verifier_id !== "PAIR_EXPERIENCE_EXTRACTION",
      detail: `${opts.verifier_id}!=${String(exp.extracted_by)}`,
    });

    // 7. digest valid
    checks.push({
      check: "DIGEST_VALID",
      pass: exp.experience_digest === experienceDigest(exp),
      detail: String(exp.experience_digest).slice(0, 12),
    });

    // 8. not stale
    const staleAfter = exp.stale_after ?? (exp.trust_metadata as Record<string, unknown>)?.stale_after;
    const staleNow = exp.stale === true || (staleAfter != null && String(staleAfter) < utcnow());
    checks.push({ check: "NOT_STALE", pass: !staleNow, detail: String(staleAfter ?? "") });

    // 9. poisoning defense
    checks.push(...this.poisonChecks(exp, opts.target));

    // 10. minimum support (ACTIVE only)
    if (opts.target === "ACTIVE") {
      const need =
        Number(exp.min_support ?? 0) ||
        DEFAULT_MIN_SUPPORT[String(exp.type)] ||
        1;
      checks.push({
        check: "MIN_SUPPORT",
        pass: Number(exp.observation_count ?? 1) >= need,
        detail: `${Number(exp.observation_count ?? 1)}/${need}`,
      });
    }

    // 11. unresolved blocking contradiction — a contradiction on a
    //    QUALIFIED/ACTIVE-claim candidate blocks ACTIVE promotion.
    const contradictions = (exp.contradictions as Array<Record<string, unknown>>) ?? [];
    checks.push({
      check: "NO_BLOCKING_CONTRADICTION",
      pass: opts.target !== "ACTIVE" || contradictions.length === 0,
      detail: `${contradictions.length}`,
    });

    return this.result(expId, opts, checks);
  }

  private result(
    expId: string,
    opts: { verifier_id: string; target: string },
    checks: VerifyCheck[],
  ): { pass: boolean; checks: VerifyCheck[]; verifier_result: Record<string, unknown> } {
    const pass = checks.every((c) => c.pass);
    return {
      pass,
      checks,
      verifier_result: {
        verifier_id: opts.verifier_id,
        target: opts.target,
        pass,
        checks,
        verified_at: utcnow(),
      },
    };
  }

  /** verify → qualify; returns the qualified experience or throws fail-closed. */
  verifyAndQualify(
    expId: string,
    verifierId: string,
  ): Record<string, unknown> {
    const { pass, checks, verifier_result } = this.verify(expId, {
      verifier_id: verifierId,
      target: "QUALIFIED",
    });
    if (!pass) {
      throw new IntegrityError(
        "FAIL_CLOSED_EXPERIENCE_VERIFICATION",
        JSON.stringify(checks.filter((c) => !c.pass).map((c) => c.check)),
      );
    }
    return this.experience.qualify(expId, { verifier_id: verifierId, verifier_result });
  }

  /** verify → activate (candidate must already be QUALIFIED). */
  verifyAndActivate(
    expId: string,
    verifierId: string,
  ): Record<string, unknown> {
    const { pass, checks, verifier_result } = this.verify(expId, {
      verifier_id: verifierId,
      target: "ACTIVE",
    });
    if (!pass) {
      throw new IntegrityError(
        "FAIL_CLOSED_EXPERIENCE_ACTIVATION",
        JSON.stringify(checks.filter((c) => !c.pass).map((c) => c.check)),
      );
    }
    return this.experience.activate(expId, { verifier_id: verifierId, verifier_result });
  }
}
