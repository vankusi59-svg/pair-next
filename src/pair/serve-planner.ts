/**
 * The production runtime planner composition used by
 * `scripts/serve-mission-control.mjs`.
 *
 * Lives in `src/pair` (not inline in the serve script) so the EXACT
 * production composition seam is importable and exercisable in tests —
 * a test drives the same `planner` function object production wiring
 * instantiates, never a reimplementation.
 *
 * F3 R1.1 — replan discipline:
 *   - `reason === "initial"` accepts ONLY authorized plan authority:
 *     confirmed `pinned_plan_tasks` verbatim → `metadata.llm_plan`
 *     through the canonicalize seam. Phase C — the deterministic
 *     template plan is REMOVED: a mission reaching the planner without
 *     a persisted plan fails closed FAIL_CLOSED_PLAN_REQUIRED. Genuine
 *     planning happens ONLY in the async LLM Planner Pool at the
 *     expander edge; its winner travels as `metadata.llm_plan`.
 *   - `reason === "replan"` NEVER silently replays a stored plan
 *     (pinned / llm_plan / unchanged template) as though it were a
 *     fresh alternative. A replan must come from a configured governed
 *     replan provider that receives the structured F3 `replan_context`;
 *     with none configured the planner throws
 *     `FAIL_CLOSED_REPLAN_PROVIDER_UNAVAILABLE`, which MissionRuntime
 *     treats as the REPLAN action itself being infeasible — recovery
 *     falls through to the RecoveryController's next bounded action.
 *
 *   The production LLM planner (`llmPlan`) is asynchronous and cannot
 *   run inside the synchronous `RuntimePlanner` contract, so production
 *   wiring passes no `replanProvider`: live production replanning is
 *   explicitly UNSUPPORTED under the current sync contract and REPLAN
 *   fails closed rather than replaying the old plan.
 */
import {
  isBookkeepingShapedTask,
  reservedAutomatonMisuseKey,
  resolveWorkTaskBudget,
  sanitizePlan,
  goalRequiresCurrentExternalData,
  taskRequiresNetworkAccess,
  instructionIsDataGathering,
  instructionSatisfiesGoalSubject,
  externalSubjectKeys,
  subjectAnchors,
} from "./llm-planner.js";
import {
  extractGoalHosts,
  FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID,
  networkRequirementFieldState,
  resolveFreshTaskNetworkAuthority,
  resolveTaskNetworkAuthority,
  type NetworkRequirement,
} from "./network-requirement.js";
import {
  reconcilePlanDataflow,
  detectTelegramDeliveryIntent,
  CANONICAL_BOOKKEEPING_INSTRUCTION,
  isDeliveryTask,
  inspectRawDeliveryEmissions,
  type RawDeliveryEmissionState,
  PAIR_DELIVERY_INJECTION_KEY,
  type DeliveryInjectionRecord,
  type ExternalInputArtifactSource,
  type TelegramDeliveryIntent,
  isContentBearing,
} from "./plan-dataflow.js";
import { detectOutputLanguage } from "./output-language.js";
import {
  authoritativeGoalText,
  extractGoalContract,
} from "./goal-contract.js";
import { assertPlanCoverage } from "./plan-coverage.js";
import { IntegrityError } from "./errors.js";
import type { RuntimePlanner, RuntimePlannerInput } from "./mission-runtime.js";

/** Capability allowlist for LLM-derived plans (initial + replan). */
export const SERVE_LLM_PLANNER_CAPS = [
  "AUTOMATON_TASK_EXECUTION",
  "FILE_OPERATIONS",
  "REASONING",
  "CODE_GENERATION",
  "CODE_EDITING",
  "SHELL_EXECUTION",
  "PYTHON_EXECUTION",
  "REMOTE_CLOUD_TASK_EXECUTION",
  "AUTONOMOUS_CODE_EXECUTION",
  "TELEGRAM_DELIVERY",
  // PRV2-A R1.B — real routing fact: current/external-data tasks request
  // it; only an executor currently authorized for network access may
  // serve them (Codex live via CNI-1, Devin ambient governed network).
  "NETWORK_ACCESS",
];

/** PRV2-A R1.A — the model-visible WORK capability vocabulary: every
 *  capability a work task may request. AUTOMATON_TASK_EXECUTION is
 *  PAIR-reserved (it powers the injected bookkeeping task, which the
 *  model never authors) and is therefore NOT in this set. */
export const SERVE_LLM_WORK_CAPS = SERVE_LLM_PLANNER_CAPS.filter(
  (c) => c !== "AUTOMATON_TASK_EXECUTION",
);


/** PRV2-A §D — the PAIR-owned bookkeeping task: deterministic identity
 *  (T1, canonical instruction, canonical worker_spec carrying the goal as
 *  payload — never as an instruction the model could contaminate). */
export function canonicalBookkeepingTask(goal: string): Record<string, unknown> {
  return {
    task_key: "T1",
    title: "record mission goal",
    task_instruction: CANONICAL_BOOKKEEPING_INSTRUCTION,
    required_capabilities: ["AUTOMATON_TASK_EXECUTION"],
    depends_on: [],
    metadata: {
      expected_output_contract: {
        type: "TASK_RESULT",
        worker_spec: {
          ops: [
            {
              op: "write_text_file",
              path: "mission_goal.txt",
              content: goal,
              idempotency_class: "WRITE",
              risk_class: "MEDIUM",
            },
            {
              op: "finish",
              result: { summary: "goal recorded" },
              idempotency_class: "READ_ONLY",
              risk_class: "LOW",
            },
          ],
          limits: { max_ops: 4, timeout_seconds: 30 },
          allowed_ops: ["write_text_file", "finish"],
        },
      },
    },
  };
}

export interface ServePlannerDeps {
  /** Capability sets of the currently-qualified executors — sanitizePlan
   *  drops tasks no single executor can serve. */
  executorCapSets: () => string[][];
  /** Optional SYNCHRONOUS governed replan provider. Receives the full
   *  RuntimePlannerInput including `replan_context`; its raw candidate
   *  still flows through the same canonicalize seam — no direct commit
   *  from provider output. Absent → REPLAN reports unavailability. */
  replanProvider?:
    | ((
        input: RuntimePlannerInput,
      ) => { tasks?: Array<Record<string, unknown>> } | null | undefined)
    | null;
}

/** THE ONE canonical LLM-plan preparation seam (Phase B R1 §7):
 *  sanitize + deterministic PAIR_NATIVE contract enrichment +
 *  dataflow reconcile — the failover winner-check, the pinned
 *  canonical_tasks, and the committed plan are the same list by
 *  construction. */
export function makeServeCanonicalizer(deps: {
  executorCapSets: () => string[][];
  /** PRV2-A §E — optional configured work-task ceiling (only tightens the
   *  derived adaptive budget; hard ceiling 12 always applies). */
  maxWorkTasks?: number;
}): (
  rawTasks: Array<Record<string, unknown>>,
  goal: string,
  ctx?: {
    provenance?: "fresh" | "persisted";
    /** HOTFIX 1 R1/R2 — TRUE raw TELEGRAM_DELIVERY emission evidence
     *  captured on the parsed provider JSON BEFORE the transport's own
     *  sanitize/drop pass, threaded through runPlannerFailover for THIS
     *  exact invocation. When absent the caller vouches that `rawTasks`
     *  IS the unsanitized emission (direct/replan seams). */
    raw_delivery_emission_count?: number;
    /** R2 — tri-state verdict for the count: ABSENT = proven omission,
     *  PRESENT = proven emission, INDETERMINATE = detector budget
     *  exhausted before all capability content was inspected (NEVER a
     *  proven R=0 — fail closed). */
    raw_delivery_emission_state?: RawDeliveryEmissionState;
    /** HOTFIX-A — the bounded cross-mission eligible set computed by
     *  trusted PAIR code for this mission (empty/absent = no
     *  cross-mission consumption is authorized). */
    external_input_artifacts?: ExternalInputArtifactSource[];
  },
) => Array<Record<string, unknown>> {
  return (rawTasks, goal, ctx) => {
    // HOTFIX 1 — delivery omission provenance is measured on the RAW
    // candidate BEFORE sanitize/drop/remap so a TRUE omission (planner
    // never attempted a delivery task) can be told apart from a
    // malformed emission that canonical preparation dropped. The
    // operator request remains the ONLY delivery authority.
    // R1 — `ctx.raw_delivery_emission_count` is the REAL raw evidence
    // captured inside the planner transport (llmPlan/codexPlannerPlan)
    // BEFORE its own sanitizePlan; the incoming task list has already
    // survived that first drop and can no longer prove it.
    const deliveryIntent = detectTelegramDeliveryIntent(
      authoritativeGoalText(String(goal ?? "")),
    );
    // R2 — evidence is the tri-state inspection: an explicit
    // `raw_delivery_emission_state`/`_count` pair wins (production
    // failover always supplies it); absent evidence means the caller
    // vouches `rawTasks` is the unsanitized emission, so it is inspected
    // HERE — never inferred from sanitized tasks and never substituted
    // with a fallback count that could launder uncertainty into a
    // proven omission.
    const rawInspection =
      ctx?.raw_delivery_emission_count !== undefined ||
      ctx?.raw_delivery_emission_state !== undefined
        ? {
            state: ctx?.raw_delivery_emission_state ??
              ((ctx?.raw_delivery_emission_count ?? 0) > 0
                ? "PRESENT"
                : "ABSENT"),
            count: ctx?.raw_delivery_emission_count ?? 0,
          }
        : inspectRawDeliveryEmissions(rawTasks);
    const rawDeliveryCount = rawInspection.count;
    // PRV2-A §D — the model emits WORK tasks only; PAIR owns bookkeeping.
    // A model-emitted bookkeeping-shaped task (filtered caps ⊆
    // {AUTOMATON_TASK_EXECUTION}) is deterministically normalized away so
    // the plan can never carry two bookkeeping authorities.
    const bookkeepingKeys = new Set<string>();
    // PRV2-A R1.A — reserved-capability misuse is a deterministic typed
    // reject: any task carrying AUTOMATON_TASK_EXECUTION that is not
    // pure-bookkeeping-shaped (a MIXED task, or a pure task with a
    // foreign worker_spec) can never become a canonical work task — no
    // stripping, no second bookkeeping worker_spec, no false-completion
    // path. The candidate fails PLAN_INVALID and failover proceeds.
    const misuseKey = reservedAutomatonMisuseKey(
      (rawTasks ?? []) as Array<Record<string, unknown>>,
    );
    if (misuseKey) {
      throw new IntegrityError(
        "FAIL_CLOSED_PLAN_RESERVED_CAPABILITY_AUTOMATON_TASK_EXECUTION",
        `task ${misuseKey} requests PAIR-reserved AUTOMATON_TASK_EXECUTION outside bookkeeping shape`,
      );
    }
    const workRaw = (rawTasks ?? []).filter((t) => {
      const shaped = isBookkeepingShapedTask(
        (t ?? {}) as Record<string, unknown>,
        SERVE_LLM_PLANNER_CAPS,
      );
      if (shaped) {
        const k = String((t as Record<string, unknown>)?.task_key ?? "");
        if (k) bookkeepingKeys.add(k);
      }
      return !shaped;
    });
    // PRV2-A §E — adaptive work-task budget bounds the work graph; the
    // injected bookkeeping task is not counted against it.
    const workBudget = resolveWorkTaskBudget(goal, deps.maxWorkTasks);
    const { tasks } = sanitizePlan(
      workRaw as never[],
      SERVE_LLM_WORK_CAPS,
      workBudget,
      deps.executorCapSets() as never[],
    );
    const canonicalDeliveryCount = (tasks as Array<Record<string, unknown>>)
      .filter(isDeliveryTask).length;
    const freshPlan = ctx?.provenance !== "persisted";
    if (freshPlan && rawInspection.state === "INDETERMINATE") {
      // R2 defect B — the detector could not inspect every capability
      // field (depth/node budget): omission is UNPROVEN, never R=0.
      // A deterministic typed fail-closed verdict at this boundary —
      // no injection, no silent pass.
      throw new IntegrityError(
        "FAIL_CLOSED_DELIVERY_EMISSION_INDETERMINATE",
        JSON.stringify({ emissions_seen: rawInspection.count }),
      );
    }
    if (freshPlan && canonicalDeliveryCount > rawDeliveryCount) {
      // R2 defect C — impossible raw/canonical relationship: every
      // canonical delivery task descends from a raw capability token
      // the detector must have seen. C > R means the evidence itself
      // is inconsistent (buggy/forged transport evidence) — never
      // repaired, never converted into a fallback count.
      throw new IntegrityError(
        "FAIL_CLOSED_DELIVERY_COUNT_INCONSISTENT",
        JSON.stringify({
          raw_delivery: rawDeliveryCount,
          canonical_delivery: canonicalDeliveryCount,
        }),
      );
    }
    if (freshPlan && !deliveryIntent.requested && rawDeliveryCount > 0) {
      // R1 truth table — the model ATTEMPTED unauthorized delivery
      // semantics. The same fail-closed verdict the reconcile gate
      // already gives on a surviving delivery task, now also provable
      // when the transport sanitize dropped every attempt first.
      throw new IntegrityError(
        "FAIL_CLOSED_TELEGRAM_DELIVERY_INTENT",
        JSON.stringify({ raw_delivery: rawDeliveryCount }),
      );
    }
    if (freshPlan && deliveryIntent.requested && rawDeliveryCount > 1) {
      // R1 truth table — exactly-one semantics hold on the RAW emission:
      // a duplicate delivery attempt never becomes valid just because
      // the transport sanitize silently dropped all but one.
      throw new IntegrityError(
        "FAIL_CLOSED_DELIVERY_TASK_AMBIGUOUS",
        JSON.stringify({
          raw_delivery: rawDeliveryCount,
          canonical_delivery: canonicalDeliveryCount,
        }),
      );
    }
    if (
      freshPlan &&
      deliveryIntent.requested &&
      rawDeliveryCount > 0 &&
      canonicalDeliveryCount < rawDeliveryCount
    ) {
      // HOTFIX 1 §F — the planner TRIED to emit a delivery task but it
      // was malformed/unservable/dropped: NOT a true omission. PAIR must
      // never "repair into validity" a failed planner emission by
      // swapping in a clean one — fail closed instead of silently
      // injecting. R1 — evidence lost during preparation (C < R) is the
      // same class, whether dropped by the transport sanitize or by the
      // canonical one.
      throw new IntegrityError(
        "FAIL_CLOSED_DELIVERY_TASK_INVALIDATED",
        JSON.stringify({
          raw_delivery: rawDeliveryCount,
          canonical_delivery: canonicalDeliveryCount,
        }),
      );
    }
    if (!tasks.length) return [] as Array<Record<string, unknown>>;
    // PRV2-A R2 + NETWORK-REQ R1/R2 + PLANNER-CONTRACT SIMPLIFICATION —
    // deterministic network authority at the canonical seam (prompt
    // wording is guidance, never authority). Provenance picks the
    // verdict, CALL-SITE context never inferred from data:
    //  FRESH (every planner transport): resolveFreshTaskNetworkAuthority
    //    — PAIR derives the requirement itself from goal + instruction
    //    text alone (fetch-shaped instruction, or an instruction-named
    //    host). The structured field is advisory metadata that is never
    //    read for the verdict: it can neither grant nor deny authority,
    //    so wrong/malformed/conflicting annotations never reject. The
    //    single fresh rejection class is
    //    UNAUTHORIZED_SOURCE — an instruction-named host the goal does
    //    not authorize, or a derived requirement with zero authorization
    //    evidence.
    //    REQUIRED  — needs network AND authorized: PAIR binds
    //      NETWORK_ACCESS upstream (repair, servable by executor policy).
    //    NOT_REQUIRED — no derived need; a planner NETWORK_ACCESS claim
    //      is advisory routing metadata, not a rejection reason.
    //  PERSISTED (metadata.llm_plan only): the pre-simplification
    //    verdict (resolveTaskNetworkAuthority) is preserved verbatim —
    //    LEGACY detectors, NOT_REQUIRED+claim → UNAUTHORIZED_CAPABILITY.
    const netFresh = ctx?.provenance !== "persisted";
    const netGoalHosts = extractGoalHosts(goal);
    const netGoalDemand = goalRequiresCurrentExternalData(goal);
    const netGoalHasSubject =
      externalSubjectKeys(goal).size > 0 || subjectAnchors(goal).size > 0;
    const taskNetRes = (t: Record<string, unknown>) => {
      const md = (t.metadata ?? {}) as Record<string, unknown>;
      const instr = String(t.task_instruction ?? "");
      return netFresh
        ? resolveFreshTaskNetworkAuthority({
            req: (md.network_requirement ?? null) as NetworkRequirement | null,
            state: networkRequirementFieldState(t),
            goalHosts: netGoalHosts,
            instructionRequiresNetwork: taskRequiresNetworkAccess(instr),
            goalRequiresExternalData: netGoalDemand,
            instructionMatchesGoalSubject:
              netGoalHasSubject &&
              instructionSatisfiesGoalSubject(instr, goal),
            instruction: instr,
          })
        : resolveTaskNetworkAuthority({
            req: (md.network_requirement ?? null) as NetworkRequirement | null,
            state: networkRequirementFieldState(t),
            goalHosts: netGoalHosts,
            fresh: false,
          });
    };
    for (const t of tasks) {
      const res = taskNetRes(t);
      if (res.verdict === "INVALID") {
        throw new IntegrityError(
          FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID,
          JSON.stringify({
            task: String(t.task_key),
            reason: res.reason,
          }),
        );
      }
      const caps = (t.required_capabilities as string[] | undefined) ?? [];
      if (!netFresh && res.verdict === "NOT_REQUIRED" && caps.includes("NETWORK_ACCESS")) {
        // Persisted-only: a structured NOT_REQUIRED field under the old
        // contract makes a NETWORK_ACCESS claim unauthorized.
        throw new IntegrityError(
          FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID,
          JSON.stringify({
            task: String(t.task_key),
            reason: "UNAUTHORIZED_CAPABILITY",
          }),
        );
      }
    }
    const anyDerivedRequired = tasks.some(
      (t) => taskNetRes(t).verdict === "REQUIRED",
    );
    if (!anyDerivedRequired && goalRequiresCurrentExternalData(goal)) {
      const legitimate = tasks.some((t) => {
        const caps = (t.required_capabilities as string[] | undefined) ?? [];
        const instr = String(t.task_instruction ?? "");
        return (
          caps.includes("NETWORK_ACCESS") &&
          instructionIsDataGathering(instr) &&
          // R4 — subject binding: the task must gather the subject the
          // goal's current-data obligation is about, not merely be a
          // legitimate gatherer of something unrelated.
          instructionSatisfiesGoalSubject(instr, goal)
        );
      });
      if (!legitimate) {
        throw new IntegrityError(
          "FAIL_CLOSED_PLAN_NETWORK_CAPABILITY_REQUIRED",
          "goal requires current/external data but no legitimate NETWORK_ACCESS data-gathering task",
        );
      }
    }
    for (const t of tasks) {
      const caps = (t.required_capabilities as string[] | undefined) ?? [];
      const res = taskNetRes(t);
      const requires =
        res.verdict === "REQUIRED"
          ? true
          : res.verdict === "LEGACY"
            ? taskRequiresNetworkAccess(String(t.task_instruction ?? ""))
            : false;
      if (requires && !caps.includes("NETWORK_ACCESS")) {
        throw new IntegrityError(
          "FAIL_CLOSED_TASK_NETWORK_CAPABILITY_REQUIRED",
          `task ${String(t.task_key)} requests live/web fetching without NETWORK_ACCESS`,
        );
      }
    }
    // PRV2-A §D — deterministic key/dependency remap: kept work tasks
    // become T2..T(n+1) in emitted order; a dependency on a dropped
    // bookkeeping-shaped task resolves to PAIR's injected T1.
    const keyMap = new Map<string, string>();
    tasks.forEach((t, i) => keyMap.set(String(t.task_key), `T${i + 2}`));
    const rawByKey = new Map(
      (rawTasks ?? []).map((t) => [
        String((t as Record<string, unknown>)?.task_key ?? ""),
        t as Record<string, unknown>,
      ]),
    );
    const workTasks = tasks.map((t) => {
      const raw = rawByKey.get(String(t.task_key));
      const rawDeps = Array.isArray(raw?.depends_on)
        ? (raw!.depends_on as unknown[]).map((d) => String(d))
        : [];
      const remapped = [
        ...(rawDeps.some((d) => bookkeepingKeys.has(d)) ? ["T1"] : []),
        ...(((t.depends_on as string[]) ?? [])
          .map((d) => keyMap.get(d))
          .filter((d): d is string => typeof d === "string")),
      ];
      return {
        ...t,
        task_key: keyMap.get(String(t.task_key))!,
        depends_on: [...new Set(remapped)],
      };
    });
    const tasksWithBookkeeping: Array<Record<string, unknown>> = [
      canonicalBookkeepingTask(String(goal ?? "")),
      ...workTasks,
    ];
    const allTasks = tasksWithBookkeeping;
    // PAIR_NATIVE tasks need an expected_output_contract worker_spec —
    // the LLM cannot emit one, so inject the canonical write-file
    // contract for any native-capability task that lacks it.
    for (const t of allTasks) {
      const caps = t.required_capabilities as string[];
      if (!caps.includes("AUTOMATON_TASK_EXECUTION")) continue;
      const md = (t.metadata ??= {}) as Record<string, unknown>;
      if (md.expected_output_contract) continue;
      md.expected_output_contract = {
        type: "TASK_RESULT",
        worker_spec: {
          ops: [
            {
              op: "write_text_file",
              path: "mission_goal.txt",
              content: goal,
              idempotency_class: "WRITE",
              risk_class: "MEDIUM",
            },
            {
              op: "finish",
              result: { summary: "goal recorded" },
              idempotency_class: "READ_ONLY",
              risk_class: "LOW",
            },
          ],
          limits: { max_ops: 4, timeout_seconds: 30 },
          allowed_ops: ["write_text_file", "finish"],
        },
      };
    }
    // HOTFIX 1 — deterministic delivery-omission repair at THE canonical
    // preparation seam (fresh provenance only; persisted plans are
    // historical authority and replay verbatim). Three proofs before
    // injection: operator intent (requested), TRUE omission (the RAW
    // candidate attempted zero delivery tasks — a dropped malformed
    // emission already failed closed above), and executor servability
    // (TELEGRAM_DELIVERY inside the canonical work vocabulary AND
    // routable by a currently-qualified executor capability set).
    if (ctx?.provenance !== "persisted") {
      injectDeliveryTaskForTrueOmission(
        allTasks,
        deliveryIntent,
        {
          canonical: canonicalDeliveryCount,
          raw: rawDeliveryCount,
        },
        deps.executorCapSets,
      );
    }
    // Incident R1/R2 — deterministic artifact data-flow reconciliation
    // at THE canonical seam, before validatePlanProposal + plan_digest:
    // a task consuming an artifact must depend on its unique earlier
    // producer; unbound/ambiguous/backward producers throw
    // FAIL_CLOSED_PLAN_DATAFLOW_*. The telegram delivery authority is
    // the operator REQUEST alone.
    reconcilePlanDataflow(allTasks as never[], {
      telegramIntent: deliveryIntent,
      outputLanguage: detectOutputLanguage(
        authoritativeGoalText(String(goal ?? "")),
      ),
      external_input_artifacts: ctx?.external_input_artifacts,
    });
    // PRV2-B — Goal Contract coverage authority, AFTER dataflow
    // reconcile and remap so the check binds the canonical task keys
    // the plan will pin: every mandatory obligation must be covered by
    // a genuine work task, every named deliverable by a real producer
    // (canonical artifact machinery — not filename grep), no task may
    // contradict a bounded constraint or invoke a prohibited term.
    // The contract is the deterministic projection of the raw goal — a
    // replan for the same goal is checked against the same contract
    // (replanning changes HOW, never WHAT). A fabricated model
    // `pair_coverage` mapping is evidence, never authority: PAIR
    // verifies every requirement independently.
    assertPlanCoverage(extractGoalContract(String(goal ?? "")), allTasks);
    return allTasks;
  };
}

/** HOTFIX-D — THE one governed delivery-omission injection authority.
 *  Called from the canonicalize seam (LLM/persisted candidates, fresh
 *  provenance only) AND from the deterministic template fallback tail —
 *  never duplicated, never reimplemented per call site. Three proofs
 *  before injection, in order:
 *    1. planner-forgery defense — strip `PAIR_DELIVERY_INJECTION_KEY`
 *       from every task; PAIR re-stamps only the task THIS run injects;
 *    2. operator intent + TRUE omission — `requested` AND zero canonical
 *       AND zero raw attempted delivery tasks (a dropped malformed
 *       emission already failed closed upstream — never repair into
 *       ambiguity);
 *    3. servability — TELEGRAM_DELIVERY inside the canonical work
 *       vocabulary AND routable by a currently-qualified executor
 *       capability set — else `FAIL_CLOSED_DELIVERY_INJECTION_UNSERVABLE`;
 *    4. a real producer exists — no content-bearing task upstream means
 *       nothing genuine to deliver — `FAIL_CLOSED_DELIVERY_INJECTION_NO_PRODUCER`
 *       (never fabricate an empty deliverable just to satisfy presence).
 *  The injected task is a canonical DAG leaf keyed by the next FREE
 *  `T<n>` (never a bare `T${allTasks.length+1}` — an emitted key gap,
 *  e.g. T1,T3 when DSH is absent but Codex is present, would collide).
 *  Deterministic: smallest unused key ≥ length+1, so sequential lists
 *  keep `T${len+1}` exactly as before.
 *  reconcilePlanDataflow (called by each caller) rewrites its
 *  instruction, derives producer edges, and stamps the manifest /
 *  plan-contract / output-language exactly as for a planner-emitted
 *  delivery task. */
function injectDeliveryTaskForTrueOmission(
  allTasks: Array<Record<string, unknown>>,
  deliveryIntent: TelegramDeliveryIntent,
  counts: { canonical: number; raw: number },
  executorCapSets: () => string[][],
): void {
  for (const t of allTasks) {
    const md = t.metadata as Record<string, unknown> | undefined;
    if (md && md[PAIR_DELIVERY_INJECTION_KEY] !== undefined) {
      delete md[PAIR_DELIVERY_INJECTION_KEY];
    }
  }
  if (
    !deliveryIntent.requested ||
    counts.canonical !== 0 ||
    counts.raw !== 0
  ) {
    return;
  }
  const servable =
    SERVE_LLM_WORK_CAPS.includes("TELEGRAM_DELIVERY") &&
    executorCapSets()
      .some((set) => (set as string[]).includes("TELEGRAM_DELIVERY"));
  if (!servable) {
    throw new IntegrityError(
      "FAIL_CLOSED_DELIVERY_INJECTION_UNSERVABLE",
      JSON.stringify({ requested: true, servable: false }),
    );
  }
  if (!allTasks.some((t) => isContentBearing(t))) {
    throw new IntegrityError(
      "FAIL_CLOSED_DELIVERY_INJECTION_NO_PRODUCER",
      JSON.stringify({ requested: true, content_bearing_tasks: 0 }),
    );
  }
  // F1 — canonical task-key allocation: the next FREE `T<n>`, not a
  // bare length+1 (a gap like T1,T3 would collide with the existing
  // T3). Deterministic replay preserved — same input keys always yield
  // the same delivery key.
  let nextKey = allTasks.length + 1;
  const usedKeys = new Set(allTasks.map((t) => String(t.task_key)));
  while (usedKeys.has(`T${nextKey}`)) nextKey += 1;
  const deliveryKey = `T${nextKey}`;
  const injected: Record<string, unknown> = {
    task_key: deliveryKey,
    title: "governed telegram delivery",
    // Placeholder only — reconcile rewrites the canonical
    // delivery instruction and stamps the manifest/contract/
    // output-language/edges exactly as for a planner-emitted task.
    task_instruction:
      "Stage the manifested artifacts into outbox/ unchanged, then reply DONE.",
    required_capabilities: ["TELEGRAM_DELIVERY"],
    depends_on: [],
    metadata: {},
  };
  const record: DeliveryInjectionRecord = {
    reason: "DELIVERY_TASK_INJECTED",
    task_key: deliveryKey,
    mode: deliveryIntent.mode,
    authority: "OPERATOR_TELEGRAM_INTENT",
  };
  (injected.metadata as Record<string, unknown>)[
    PAIR_DELIVERY_INJECTION_KEY
  ] = record;
  allTasks.push(injected);
}

/** Build the production runtime planner (the `planner` dep of
 *  MissionRuntime). See module docstring for the R1.1 replan
 *  discipline. */
export function makeServePlanner(deps: ServePlannerDeps): {
  planner: RuntimePlanner;
  canonicalizeLlmTasks: ReturnType<typeof makeServeCanonicalizer>;
} {
  const canonicalizeLlmTasks = makeServeCanonicalizer({
    executorCapSets: deps.executorCapSets,
  });
  const planner: RuntimePlanner = (input) => {
    const goal = String(input.mission.goal);
    if (input.reason === "replan") {
      // F3 R1.1 — a replan must be generated by a configured governed
      // provider consuming the structured failure context. Stored plans
      // (pinned_plan_tasks / metadata.llm_plan) and the deterministic
      // template are historical authority, never a "new" candidate —
      // replaying them would just spend the bounded candidate budget on
      // guaranteed duplicates. No provider configured → the REPLAN
      // action is explicitly unavailable (fail closed upstream).
      const provider = deps.replanProvider;
      if (provider) {
        const candidate = provider(input);
        const raw = candidate?.tasks;
        if (Array.isArray(raw) && raw.length) {
          try {
            const tasks = canonicalizeLlmTasks(raw, goal, {
              external_input_artifacts: input.input_artifact_sources,
            });
            if (tasks.length) return { tasks };
          } catch (err) {
            throw new IntegrityError(
              "FAIL_CLOSED_REPLAN_PROVIDER_INFEASIBLE",
              `replan candidate failed canonicalization: ${
                String((err as { code?: string })?.code ?? "INVALID")
              }`,
            );
          }
        }
        throw new IntegrityError(
          "FAIL_CLOSED_REPLAN_PROVIDER_INFEASIBLE",
          "replan provider returned no viable candidate",
        );
      }
      throw new IntegrityError(
        "FAIL_CLOSED_REPLAN_PROVIDER_UNAVAILABLE",
        "no governed synchronous replan provider configured",
      );
    }
    // Phase B pinned plan: a confirmed preview carries the EXACT
    // persisted canonical task list — return it verbatim
    // (validatePlanProposal re-validates; commitPlan pins the
    // manifest). The planner is never re-invoked for a pinned mission.
    const mdata = (input.mission?.metadata ?? {}) as Record<string, unknown>;
    const pinned = mdata.pinned_plan_tasks as unknown[] | undefined;
    if (Array.isArray(pinned) && pinned.length) {
      return { tasks: pinned as Array<Record<string, unknown>> };
    }
    const llm = mdata.llm_plan as unknown[] | undefined;
    if (Array.isArray(llm) && llm.length) {
      // R2 — persisted-plan provenance: this list was canonicalized and
      // stored before the structured network requirement was mandatory.
      // Explicit context proves legacy; a field-less task here may fall
      // back to the legacy detectors (fresh emissions never reach this
      // branch — they come through the planner transports above).
      const tasks = canonicalizeLlmTasks(
        llm as Array<Record<string, unknown>>,
        goal,
        {
          provenance: "persisted",
          external_input_artifacts: input.input_artifact_sources,
        },
      );
      if (tasks.length) return { tasks };
    }
    // Phase C — deterministic mission-planning template REMOVED. A new
    // Mission must carry authorized plan authority — a confirmed
    // preview's `pinned_plan_tasks` or a Planner Pool winner persisted
    // as `metadata.llm_plan` (produced by the shared async expander
    // edge BEFORE mission creation, for direct/draft/scheduled and
    // delegated opens alike). Reaching this tail means a mission was
    // admitted without a persisted plan — typed fail-closed, never a
    // synthesized task list, never a T1-only "successful" plan, never
    // a silent substitution.
    throw new IntegrityError(
      "FAIL_CLOSED_PLAN_REQUIRED",
      "mission has no persisted plan authority — planning must run through the LLM Planner Pool before mission start",
    );
  };
  return { planner, canonicalizeLlmTasks };
}
