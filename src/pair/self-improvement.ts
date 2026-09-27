/**
 * P8 SelfImprovementController — governed self-modification orchestration.
 *
 * Authority boundary: this controller is proposal/test/verification
 * orchestration ONLY. It never edits the canonical worktree, never merges,
 * never acquires credentials, never expands authority. All mutation happens
 * in an isolated disposable git worktree pinned to an exact parent commit;
 * promotion requires explicit operator authorization and still does not merge
 * into `lab` (operators merge).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { digest, newId, utcnow } from "./canonical.js";
import { IntegrityError, PolicyError } from "./errors.js";
import type { PairControlPlane } from "./service.js";
import type { PairEvidenceStore } from "./store.js";

export const SELFMOD_SCHEMA = "pair.os.vnext.selfmod.v1";
export const SELFMOD_POLICY_VERSION = "pair.os.vnext.selfmod-policy.v1";

export const SELFMOD_STATUSES = [
  "OBSERVED_WEAKNESS",
  "HYPOTHESIS",
  "CHANGE_PROPOSAL",
  "ISOLATED_PATCH",
  "VALIDATION",
  "INDEPENDENT_VERIFICATION",
  "PROMOTION_CANDIDATE",
  "APPROVED_PROMOTION",
  "REJECTED",
  "ROLLED_BACK",
] as const;

export const CHANGE_CLASSES = [
  "SAFE_INTERNAL",
  "BEHAVIORAL",
  "SECURITY_SENSITIVE",
  "AUTHORITY_CHANGING",
  "UNKNOWN",
] as const;
export type ChangeClass = (typeof CHANGE_CLASSES)[number];

/** Authority/protected surfaces — a patch touching these can never auto-promote. */
const AUTHORITY_PATTERNS = [
  /src\/pair\/(gate|capability-router|executor-registry|route-registry|route-selector|route-ledger|mission-router)\.ts$/,
  /src\/pair\/(store|canonical|errors)\.ts$/,
  /permission|credential|secret|auth|workspace|approval|governance|policy/i,
  /self-improvement\.ts$/,
  /experience-verifier\.ts$/,
  /artifact-validation\.ts$/,
  /worker-protocol\.ts$/,
];
const SECURITY_PATTERNS = [
  /security|crypto|tls|ssl|sanitize|escape|inject|scan/i,
  /\.env|\.npmrc|\.gitignore$/,
];
const BEHAVIORAL_PATTERNS = [
  /advisor|routing|planner|recovery|score|rank|schedule|heuristic/i,
];
const KNOWN_CODE_EXTENSIONS = new Set([".ts", ".js", ".mts", ".cts", ".json", ".yaml", ".yml", ".md", ".toml"]);

export function classifyChangedFiles(files: string[]): { change_class: ChangeClass; hits: Record<string, string> } {
  const hits: Record<string, string> = {};
  let cls: ChangeClass = "SAFE_INTERNAL";
  for (const f of files) {
    if (AUTHORITY_PATTERNS.some((re) => re.test(f))) {
      hits[f] = "AUTHORITY_CHANGING";
      cls = "AUTHORITY_CHANGING";
    } else if (SECURITY_PATTERNS.some((re) => re.test(f))) {
      hits[f] = "SECURITY_SENSITIVE";
      if (cls === "SAFE_INTERNAL" || cls === "BEHAVIORAL") cls = "SECURITY_SENSITIVE";
    } else if (BEHAVIORAL_PATTERNS.some((re) => re.test(f))) {
      hits[f] = "BEHAVIORAL";
      if (cls === "SAFE_INTERNAL") cls = "BEHAVIORAL";
    } else if (!KNOWN_CODE_EXTENSIONS.has(path.extname(f))) {
      hits[f] = "UNKNOWN";
      if (cls === "SAFE_INTERNAL" || cls === "BEHAVIORAL") cls = "UNKNOWN";
    } else {
      hits[f] = hits[f] ?? "SAFE_INTERNAL";
    }
  }
  return { change_class: cls, hits };
}

/** Weakness signals that may enter self-improvement. */
const ALLOWED_WEAKNESS_CLASSES = new Set([
  "INTERNAL_RUNTIME_DEFECT",
  "PLANNER_VALIDATION_DEFECT",
  "ADAPTER_NORMALIZATION_DEFECT",
  "RECOVERY_LOGIC_DEFECT",
  "ROUTING_IMPLEMENTATION_DEFECT",
  "TEST_REGRESSION",
]);
/** Never self-mod for these (transient/external/user-scoped). */
const EXCLUDED_WEAKNESS = new Set([
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "MODEL_UNAVAILABLE",
  "AUTHENTICATION_FAILURE",
  "AUTHORIZATION_FAILURE",
  "PERMISSION_DENIAL",
  "POLICY_DENIAL",
  "WORKSPACE_DENIAL",
  "CANCELLED",
]);

export interface PatchGenerator {
  /** executor/model identity that generated the patch — cannot self-verify */
  generator_id: string;
  /** applies changes inside the isolated worktree; returns changed files + summary */
  apply(worktreePath: string, hypothesis: Record<string, unknown>): { changed_files: string[]; summary: string };
}

export interface ValidationRunner {
  /** run a gate command in a worktree; returns pass/fail + output digest */
  run(step: string, worktreePath: string): { pass: boolean; detail: string };
}

const DEFAULT_VALIDATION_STEPS = [
  "typecheck",
  "focused_regression",
  "full_deterministic_regression",
  "security_invariants",
  "governance_invariants",
  "credential_leak_scan",
];

export class SelfImprovementController {
  constructor(
    private readonly service: PairControlPlane,
    private readonly opts: {
      /** canonical repo path — never mutated */
      repoRoot: string;
      /** root under which disposable worktrees are created */
      selfmodRoot: string;
      min_observations?: number;
    },
  ) {}

  private get store(): PairEvidenceStore {
    return this.service.store;
  }

  private transition(candidate: Record<string, unknown>, to: string, eventType: string): Record<string, unknown> {
    const allowed: Record<string, string[]> = {
      OBSERVED_WEAKNESS: ["HYPOTHESIS", "REJECTED", "ROLLED_BACK"],
      HYPOTHESIS: ["CHANGE_PROPOSAL", "REJECTED", "ROLLED_BACK"],
      CHANGE_PROPOSAL: ["ISOLATED_PATCH", "REJECTED", "ROLLED_BACK"],
      ISOLATED_PATCH: ["VALIDATION", "REJECTED", "ROLLED_BACK"],
      VALIDATION: ["INDEPENDENT_VERIFICATION", "REJECTED", "ROLLED_BACK"],
      INDEPENDENT_VERIFICATION: ["PROMOTION_CANDIDATE", "REJECTED", "ROLLED_BACK"],
      PROMOTION_CANDIDATE: ["APPROVED_PROMOTION", "REJECTED", "ROLLED_BACK"],
      APPROVED_PROMOTION: ["ROLLED_BACK"],
      // ROLLED_BACK is the cleanup terminal — a REJECTED candidate may still
      // be rolled back (worktree teardown) without resurrecting.
      REJECTED: ["ROLLED_BACK"],
      ROLLED_BACK: [],
    };
    if (!(allowed[String(candidate.status)] ?? []).includes(to)) {
      throw new IntegrityError("FAIL_CLOSED_SELFMOD_TRANSITION", `${candidate.status}→${to}`);
    }
    const next = { ...candidate, status: to, version: candidate.version };
    const saved = this.store.put("selfmod_candidate", String(candidate.change_id), next, Number(candidate.version));
    this.store.event({
      entity_type: "selfmod_candidate",
      entity_id: String(candidate.change_id),
      event_type: eventType,
      old_state: String(candidate.status),
      new_state: to,
      actor: "PAIR_SELF_IMPROVEMENT_CONTROLLER",
      correlation_id: String(candidate.correlation_id ?? ""),
    });
    return saved;
  }

  /**
   * Record a structural weakness signal. Repeated verified occurrences
   * (>= min_observations) promote it to a hypothesis-ready candidate.
   * Excluded failure classes can never open a candidate.
   */
  observeWeakness(input: {
    weakness_class: string;
    signature: string;
    evidence_refs: string[];
    description: string;
    correlation_id?: string;
  }): Record<string, unknown> {
    if (EXCLUDED_WEAKNESS.has(input.weakness_class)) {
      throw new PolicyError("FAIL_CLOSED_SELFMOD_WEAKNESS_CLASS_EXCLUDED", input.weakness_class);
    }
    if (!ALLOWED_WEAKNESS_CLASSES.has(input.weakness_class)) {
      throw new PolicyError("FAIL_CLOSED_SELFMOD_WEAKNESS_CLASS_UNKNOWN", input.weakness_class);
    }
    // Rejected digests are permanently non-re-promotable — check before
    // folding so a rejected signature can never resurrect as new evidence.
    const rejected = this.store.list("selfmod_candidate").find(
      (c) => c.signature === input.signature && c.status === "REJECTED",
    );
    if (rejected) {
      throw new PolicyError("FAIL_CLOSED_SELFMOD_REJECTED_DIGEST", input.signature);
    }
    // Recurrence dedup: same signature folds into one candidate series.
    const existing = this.store
      .list("selfmod_candidate")
      .find((c) => !["REJECTED", "ROLLED_BACK"].includes(String(c.status)) && c.signature === input.signature);
    const evidenceSet = new Set(input.evidence_refs);
    if (existing) {
      const refs = new Set([...(existing.evidence_refs as string[]), ...evidenceSet]);
      const next = {
        ...existing,
        evidence_refs: [...refs],
        observation_count: refs.size,
        version: existing.version,
      };
      return this.store.put("selfmod_candidate", String(existing.change_id), next, Number(existing.version));
    }
    const changeId = newId("SMC");
    const candidate: Record<string, unknown> = {
      schema: SELFMOD_SCHEMA,
      change_id: changeId,
      status: "OBSERVED_WEAKNESS",
      weakness_class: input.weakness_class,
      signature: input.signature,
      evidence_refs: input.evidence_refs,
      observation_count: evidenceSet.size,
      description: input.description,
      correlation_id: input.correlation_id ?? null,
      created_at: utcnow(),
      version: 0,
    };
    this.store.event({
      entity_type: "selfmod_candidate",
      entity_id: changeId,
      event_type: "SELF_IMPROVEMENT_WEAKNESS_DETECTED",
      actor: "PAIR_SELF_IMPROVEMENT_CONTROLLER",
      correlation_id: input.correlation_id ?? null,
      metadata: { signature: input.signature },
    });
    return this.store.put("selfmod_candidate", changeId, candidate, 0);
  }

  hypothesize(changeId: string, hypothesis: { summary: string; proposed_change: string; expected_effect: string }): Record<string, unknown> {
    const c = this.store.get("selfmod_candidate", changeId);
    const min = this.opts.min_observations ?? 2;
    if (Number(c.observation_count) < min) {
      throw new PolicyError("FAIL_CLOSED_SELFMOD_INSUFFICIENT_OBSERVATIONS", `${c.observation_count}<${min}`);
    }
    const next = { ...c, hypothesis, version: c.version };
    const saved = this.store.put("selfmod_candidate", changeId, next, Number(c.version));
    this.store.event({
      entity_type: "selfmod_candidate",
      entity_id: changeId,
      event_type: "SELF_IMPROVEMENT_HYPOTHESIS_CREATED",
      actor: "PAIR_SELF_IMPROVEMENT_CONTROLLER",
      correlation_id: String(c.correlation_id ?? ""),
    });
    return this.transition(saved, "HYPOTHESIS", "SELF_IMPROVEMENT_HYPOTHESIS_CREATED");
  }

  proposeChange(changeId: string, proposal: { intent: string; target_files: string[]; approach: string }): Record<string, unknown> {
    const c = this.store.get("selfmod_candidate", changeId);
    const next = { ...c, change_proposal: proposal, version: c.version };
    const saved = this.store.put("selfmod_candidate", changeId, next, Number(c.version));
    return this.transition(saved, "CHANGE_PROPOSAL", "SELF_IMPROVEMENT_PROPOSED");
  }

  /**
   * Create an isolated disposable git worktree pinned to an exact parent
   * commit, let the (untrusted) generator apply its patch there, commit it in
   * the worktree, and record the patch digest. The canonical repo is never
   * touched — we refuse if worktreePath would equal the repo root.
   */
  createIsolatedPatch(changeId: string, params: {
    parent_commit: string;
    generator: PatchGenerator;
    worktree_name?: string;
  }): Record<string, unknown> {
    const c = this.store.get("selfmod_candidate", changeId);
    if (String(c.status) !== "CHANGE_PROPOSAL") {
      throw new IntegrityError("FAIL_CLOSED_SELFMOD_NOT_IN_CHANGE_PROPOSAL", String(c.status));
    }
    const worktreePath = path.join(this.opts.selfmodRoot, params.worktree_name ?? changeId);
    const resolvedRepo = fs.realpathSync(this.opts.repoRoot);
    const resolvedTarget = path.resolve(worktreePath);
    if (resolvedTarget === resolvedRepo || resolvedTarget.startsWith(resolvedRepo + path.sep)) {
      throw new PolicyError("FAIL_CLOSED_SELFMOD_CANONICAL_WORKTREE", resolvedTarget);
    }
    fs.mkdirSync(this.opts.selfmodRoot, { recursive: true });
    const branch = `selfmod/${changeId}`;
    execFileSync("git", ["-C", this.opts.repoRoot, "worktree", "add", "--detach", worktreePath, params.parent_commit], { stdio: "pipe" });
    try {
      const applied = params.generator.apply(worktreePath, (c.hypothesis as Record<string, unknown>) ?? {});
      if (!applied.changed_files.length) {
        throw new IntegrityError("FAIL_CLOSED_SELFMOD_EMPTY_PATCH", changeId);
      }
      execFileSync("git", ["-C", worktreePath, "add", "-A"], { stdio: "pipe" });
      execFileSync(
        "git",
        ["-C", worktreePath, "-c", "user.email=pair-selfmod@local", "-c", "user.name=pair-selfmod", "commit", "-m", `selfmod ${changeId}: ${applied.summary}`],
        { stdio: "pipe" },
      );
      const candidateCommit = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const diff = execFileSync("git", ["-C", worktreePath, "diff", "--name-only", params.parent_commit, candidateCommit], { encoding: "utf8" });
      const patchText = execFileSync("git", ["-C", worktreePath, "diff", params.parent_commit, candidateCommit], { encoding: "utf8" });
      const { change_class, hits } = classifyChangedFiles(applied.changed_files);
      const patchDigest = digest({ parent: params.parent_commit, diff: patchText });
      const next = {
        ...c,
        worktree_path: worktreePath,
        branch,
        parent_commit: params.parent_commit,
        candidate_commit: candidateCommit,
        changed_files: applied.changed_files,
        changed_file_classes: hits,
        change_class,
        patch_digest: patchDigest,
        generator_id: params.generator.generator_id,
        patch_summary: applied.summary,
        diff_file_list: diff.trim().split("\n").filter(Boolean),
        version: c.version,
      };
      const saved = this.store.put("selfmod_candidate", changeId, next, Number(c.version));
      this.store.event({
        entity_type: "selfmod_candidate",
        entity_id: changeId,
        event_type: "SELF_IMPROVEMENT_PATCH_CREATED",
        actor: "PAIR_SELF_IMPROVEMENT_CONTROLLER",
        correlation_id: String(c.correlation_id ?? ""),
        metadata: { patch_digest: patchDigest, generator_id: params.generator.generator_id },
      });
      return this.transition(saved, "ISOLATED_PATCH", "SELF_IMPROVEMENT_PATCH_CREATED");
    } catch (err) {
      try {
        execFileSync("git", ["-C", this.opts.repoRoot, "worktree", "remove", "--force", worktreePath], { stdio: "pipe" });
      } catch {
        /* leave the worktree for inspection */
      }
      throw err;
    }
  }

  /**
   * Run the deterministic validation pipeline inside the isolated worktree.
   * Any mandatory gate failure → REJECTED. Diff policy class is also a gate:
   * only SAFE_INTERNAL/BEHAVIORAL may proceed automatically.
   */
  validate(changeId: string, runner: ValidationRunner, steps: string[] = DEFAULT_VALIDATION_STEPS): Record<string, unknown> {
    const c = this.store.get("selfmod_candidate", changeId);
    if (String(c.status) !== "ISOLATED_PATCH") {
      throw new IntegrityError("FAIL_CLOSED_SELFMOD_NOT_PATCHED", String(c.status));
    }
    const worktree = String(c.worktree_path);
    const receipts: Array<{ step: string; pass: boolean; detail: string; ran_at: string }> = [];
    let allPass = true;
    this.store.event({
      entity_type: "selfmod_candidate",
      entity_id: changeId,
      event_type: "SELF_IMPROVEMENT_VALIDATION_STARTED",
      actor: "PAIR_SELF_IMPROVEMENT_CONTROLLER",
      correlation_id: String(c.correlation_id ?? ""),
    });
    for (const step of steps) {
      const r = runner.run(step, worktree);
      receipts.push({ step, pass: r.pass, detail: r.detail, ran_at: utcnow() });
      if (!r.pass) allPass = false;
    }
    const policyClass = String(c.change_class);
    const policyPass = policyClass === "SAFE_INTERNAL" || policyClass === "BEHAVIORAL";
    const next = {
      ...c,
      validation_receipts: receipts,
      policy_gate: { change_class: policyClass, auto_promotable: policyPass },
      validation_pass: allPass && policyPass,
      version: c.version,
    };
    const saved = this.store.put("selfmod_candidate", changeId, next, Number(c.version));
    this.store.event({
      entity_type: "selfmod_candidate",
      entity_id: changeId,
      event_type: saved.validation_pass ? "SELF_IMPROVEMENT_VALIDATION_PASSED" : "SELF_IMPROVEMENT_VALIDATION_FAILED",
      actor: "PAIR_SELF_IMPROVEMENT_CONTROLLER",
      correlation_id: String(c.correlation_id ?? ""),
      metadata: { policy_class: policyClass, gates_passed: allPass },
    });
    if (!saved.validation_pass) {
      return this.transition(saved, "REJECTED", "SELF_IMPROVEMENT_VALIDATION_FAILED");
    }
    return this.transition(saved, "VALIDATION", "SELF_IMPROVEMENT_VALIDATION_PASSED");
  }

  /** Baseline comparison record: candidate vs exact parent commit. */
  recordBaselineComparison(changeId: string, comparison: {
    baseline_commit: string;
    candidate_commit: string;
    test_delta: Record<string, number>;
    failure_delta: Record<string, number>;
    new_warnings: string[];
    new_skipped_tests: string[];
    security_invariant_delta: string;
    behavioral_invariant_delta: string;
  }): Record<string, unknown> {
    const c = this.store.get("selfmod_candidate", changeId);
    if (comparison.baseline_commit !== c.parent_commit) {
      throw new IntegrityError("FAIL_CLOSED_BASELINE_MISMATCH", `${comparison.baseline_commit}!=${c.parent_commit}`);
    }
    const next = { ...c, baseline_comparison: comparison, version: c.version };
    return this.store.put("selfmod_candidate", changeId, next, Number(c.version));
  }

  /**
   * Independent verification: the verifier must differ from the patch
   * generator. Deterministic validation remains authority; model review is
   * advisory and recorded as such.
   */
  independentVerify(changeId: string, verifier: {
    verifier_id: string;
    result: "PASS" | "FAIL";
    notes?: string;
  }): Record<string, unknown> {
    const c = this.store.get("selfmod_candidate", changeId);
    if (String(c.status) !== "VALIDATION") {
      throw new IntegrityError("FAIL_CLOSED_SELFMOD_NOT_VALIDATED", String(c.status));
    }
    if (verifier.verifier_id === c.generator_id) {
      throw new PolicyError("FAIL_CLOSED_SELFMOD_SELF_VERIFICATION", String(verifier.verifier_id));
    }
    const next = {
      ...c,
      verifier_receipts: [...((c.verifier_receipts as unknown[]) ?? []), { ...verifier, verified_at: utcnow() }],
      version: c.version,
    };
    const saved = this.store.put("selfmod_candidate", changeId, next, Number(c.version));
    if (verifier.result !== "PASS") {
      return this.transition(saved, "REJECTED", "SELF_IMPROVEMENT_VERIFICATION_FAILED");
    }
    return this.transition(saved, "INDEPENDENT_VERIFICATION", "SELF_IMPROVEMENT_VERIFIED");
  }

  /**
   * Emit the promotion candidate — pending operator approval. P8 never merges.
   */
  createPromotionCandidate(changeId: string): Record<string, unknown> {
    const c = this.store.get("selfmod_candidate", changeId);
    if (String(c.status) !== "INDEPENDENT_VERIFICATION") {
      throw new IntegrityError("FAIL_CLOSED_SELFMOD_NOT_VERIFIED", String(c.status));
    }
    const promotionId = newId("PRC");
    const receipt: Record<string, unknown> = {
      schema: "pair.os.vnext.promotion-candidate.v1",
      promotion_id: promotionId,
      change_id: changeId,
      parent_commit: c.parent_commit,
      candidate_commit: c.candidate_commit,
      patch_digest: c.patch_digest,
      changed_files: c.changed_files,
      change_class: c.change_class,
      validation_receipts: c.validation_receipts,
      verifier_receipts: c.verifier_receipts,
      security_result: c.policy_gate,
      regression_result: c.baseline_comparison ?? null,
      rollback_ref: c.parent_commit,
      approval_required: true,
      approval_status: "PENDING",
      merged: false,
      created_at: utcnow(),
      version: 0,
    };
    receipt.promotion_digest = digest(receipt);
    const saved = this.store.put("promotion_candidate", promotionId, receipt, 0);
    const promoted = this.transition(c, "PROMOTION_CANDIDATE", "PROMOTION_CANDIDATE_CREATED");
    const next = { ...promoted, promotion_id: promotionId, version: promoted.version };
    this.store.put("selfmod_candidate", changeId, next, Number(promoted.version));
    return saved;
  }

  /**
   * Operator approval — records APPROVED_PROMOTION + PROMOTION_APPROVED. The
   * candidate remains unmerged: merging into `lab` is a human git operation
   * outside this controller (spec §27: no autonomous production promotion).
   */
  approvePromotion(promotionId: string, operator: string): Record<string, unknown> {
    const p = this.store.get("promotion_candidate", promotionId);
    if (p.approval_status !== "PENDING") {
      throw new PolicyError("FAIL_CLOSED_PROMOTION_NOT_PENDING", String(p.approval_status));
    }
    const next = {
      ...p,
      approval_status: "APPROVED",
      approved_by: operator,
      approved_at: utcnow(),
      version: p.version,
    };
    const saved = this.store.put("promotion_candidate", promotionId, next, Number(p.version));
    const c = this.store.get("selfmod_candidate", String(p.change_id));
    this.transition(c, "APPROVED_PROMOTION", "PROMOTION_APPROVED");
    return saved;
  }

  rejectPromotion(promotionId: string, reason: string): Record<string, unknown> {
    const p = this.store.get("promotion_candidate", promotionId);
    const next = { ...p, approval_status: "REJECTED", rejection_reason: reason, version: p.version };
    const saved = this.store.put("promotion_candidate", promotionId, next, Number(p.version));
    const c = this.store.get("selfmod_candidate", String(p.change_id));
    this.transition(c, "REJECTED", "PROMOTION_REJECTED");
    return saved;
  }

  /**
   * Rollback: remove the isolated worktree, keep all evidence, mark the
   * candidate ROLLED_BACK and pin its patch_digest as non-re-promotable.
   */
  rollback(changeId: string, reason: string): Record<string, unknown> {
    const c = this.store.get("selfmod_candidate", changeId);
    if (c.worktree_path && fs.existsSync(String(c.worktree_path))) {
      try {
        execFileSync("git", ["-C", this.opts.repoRoot, "worktree", "remove", "--force", String(c.worktree_path)], { stdio: "pipe" });
      } catch {
        execFileSync("rm", ["-rf", String(c.worktree_path)], { stdio: "pipe" });
      }
    }
    const next = {
      ...c,
      rollback: { reason, rolled_back_at: utcnow(), rollback_ref: c.parent_commit },
      version: c.version,
    };
    const saved = this.store.put("selfmod_candidate", changeId, next, Number(c.version));
    const done = this.transition(saved, "ROLLED_BACK", "ROLLBACK_COMPLETED");
    this.store.event({
      entity_type: "selfmod_candidate",
      entity_id: changeId,
      event_type: "ROLLBACK_COMPLETED",
      actor: "PAIR_SELF_IMPROVEMENT_CONTROLLER",
      metadata: { reason, rollback_ref: c.parent_commit },
    });
    return done;
  }

  /**
   * Shadow-mode seam: run a candidate decision function WITHOUT applying it,
   * persist a shadow_comparison for the canonical-vs-candidate delta.
   */
  shadowCompare(changeId: string, input: {
    surface: string;
    canonical_decision: unknown;
    candidate_fn: () => unknown;
    correlation_id?: string;
  }): Record<string, unknown> {
    const c = this.store.get("selfmod_candidate", changeId);
    let candidateResult: unknown;
    let candidateError: string | null = null;
    try {
      candidateResult = input.candidate_fn();
    } catch (err) {
      candidateError = String(err);
      candidateResult = null;
    }
    const comparisonId = newId("SHDW");
    const same = JSON.stringify(candidateResult) === JSON.stringify(input.canonical_decision);
    const comparison: Record<string, unknown> = {
      schema: "pair.os.vnext.shadow-comparison.v1",
      comparison_id: comparisonId,
      change_id: changeId,
      surface: input.surface,
      canonical_decision: input.canonical_decision,
      candidate_decision: candidateResult,
      candidate_error: candidateError,
      decisions_equal: same,
      applied: false,
      created_at: utcnow(),
      version: 0,
    };
    comparison.comparison_digest = digest(comparison);
    return this.store.put("shadow_comparison", comparisonId, comparison, 0);
  }
}
