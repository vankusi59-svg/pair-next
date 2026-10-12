/**
 * HOTFIX-D — Delegated-mission delivery planning gap (BUG 4).
 *
 * Live evidence: delegated work item `DL_4d48de104e143ed708c9ad51`
 * (goal: "Kiểm tra đủ 3 bài ... sau đó đăng bài tóm tắt thị trường ...")
 * spawned mission `MSN_01M4PGEKGX97NGQJJEM971GYSZ` which failed
 * terminally at planning with `FAIL_CLOSED_DELIVERY_TASK_MISSING`
 * (DETERMINISTIC) — a TRUE operator delivery intent the delegated
 * template planner could never satisfy.
 *
 * Root cause: delegated work-item missions carry no `pinned_plan_tasks`
 * and no `metadata.llm_plan`, so the production planner falls through to
 * the deterministic template fallback. That path (a) never emitted a
 * TELEGRAM_DELIVERY task and (b) never passed the canonical
 * `DELIVERY_TASK_INJECTED` seam, which lived only inside
 * `canonicalizeLlmTasks` (API edge / replan / persisted branches). The
 * committed template plan then hit `assertDeliveryTaskPresence` inside
 * `assertPlanDataflow` → MISSING → terminal planning failure.
 *
 * Fix: `injectDeliveryTaskForTrueOmission` extracted from the canonical
 * preparation seam — ONE governed injection authority shared by the
 * canonicalize seam and the fresh template fallback — then the injected
 * task is canonicalized by THE canonical mutation authority
 * (`reconcilePlanDataflow`). The template's T2 instruction no longer
 * embeds the operator goal verbatim: an affirmative delivery clause
 * inside a work instruction trips `assertTaskDeliveryHygiene`
 * (reconcile) and `assertTaskDeliverySemantic` (pre-dispatch) for every
 * TRUE-intent goal. The goal remains durable in mission_goal.txt via
 * the bookkeeping task — executor behavior is preserved.
 *
 * Every test drives the SAME `makeServePlanner` function object the
 * production wiring instantiates (never a reimplementation) plus the
 * exact post-planner chain `MissionRuntime.runPlanning` performs:
 * validatePlanProposal → bindPlanExternalInputs → assertPlanDataflow.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import type { ExecutorAdapter } from "../pair/adapter.js";
import {
  ApprovalQueue,
  ArtifactProvenanceValidator,
  assertPlanDataflow,
  assertTaskDeliverySemantic,
  bindPlanExternalInputs,
  BusinessLayer,
  canonicalBookkeepingTask,
  detectOutputLanguage,
  detectTelegramDeliveryIntent,
  digest,
  ExecutorRegistry,
  externalConsumeAlias,
  EXTERNAL_INPUT_CONTRACT,
  GovernedTaskGate,
  injectDeliveryTaskForTrueOmission,
  isDeliveryTask,
  makeServePlanner,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduleService,
  MissionScheduler,
  MissionSupervisor,
  MAX_ARTIFACTS_PER_TASK,
  ObjectiveWorkstreamService,
  PAIR_DATAFLOW_SOURCES,
  PAIR_DELIVERY_INJECTION_KEY,
  PAIR_OUTPUT_LANGUAGE_KEY,
  PAIR_PLAN_CONTRACT_KEY,
  PairControlPlane,
  PairEvidenceStore,
  pendingTelegramDeliveries,
  reconcilePlanDataflow,
  ReconciliationService,
  RecoveryController,
  sha256Hex,
  TELEGRAM_DELIVERY_ATTEMPT_RESOLVED,
  TELEGRAM_DELIVERY_ATTEMPT_STARTED,
  TELEGRAM_DELIVERY_MINTED,
  TELEGRAM_MANIFEST_FIELD,
  TRANSPORT_IN_PROCESS,
  transportTelegramDelivery,
  utcnow,
  extractTaskDataflow,
  validatePlanProposal,
  workerExecutionId,
  WorkforceAllocationService,
  WorkforceService,
  type DeliveryBackend,
  type ExternalInputArtifactSource,
  type GovernedSendResult,
  type GovernedTelegramTransport,
  type RuntimePlannerInput,
} from "../pair/index.js";

/** Verbatim work-item goal from the production BUG-4 failure. */
const BUG4_GOAL =
  "Kiểm tra đủ 3 bài, tính chính xác của số liệu và nguồn trích dẫn; " +
  "xác minh kênh Telegram đích và điều kiện truy cập, sau đó đăng bài " +
  "tóm tắt thị trường và lưu bằng chứng đăng thành công. Nếu thiếu " +
  "thông tin kênh hoặc quyền truy cập, ghi rõ trở ngại.";

const CAPS = [
  "AUTOMATON_TASK_EXECUTION",
  "FILE_OPERATIONS",
  "REASONING",
  "CODE_GENERATION",
  "CODE_EDITING",
  "SHELL_EXECUTION",
  "PYTHON_EXECUTION",
  "TELEGRAM_DELIVERY",
  "NETWORK_ACCESS",
];

const deps = (over: Partial<Parameters<typeof makeServePlanner>[0]> = {}) => ({
  hasExecutor: () => true,
  executorCapSets: () => [CAPS.filter((c) => c !== "AUTOMATON_TASK_EXECUTION")],
  ...over,
});

/** A delegated work-item mission: no pinned plan, no llm_plan — exactly
 *  what the objective auto-driver creates for a DL_* item. */
const delegatedInput = (
  goal: string,
  over: Partial<RuntimePlannerInput> = {},
): RuntimePlannerInput =>
  ({
    mission: { mission_id: "MSN_BUG4", goal, metadata: {} },
    advice: null,
    reason: "initial",
    input_artifact_sources: [],
    ...over,
  }) as RuntimePlannerInput;

/** The exact post-planner validation chain MissionRuntime.runPlanning
 *  performs before commitPlan — replayed here so tests prove the plan
 *  is committable, not merely returned. */
function runPlanningChain(
  proposal: { tasks: Array<Record<string, unknown>> },
  goal: string,
  externalInputs: ExternalInputArtifactSource[] = [],
): Array<Record<string, unknown>> {
  const tasks = validatePlanProposal(
    proposal as never,
    new Set(CAPS),
  ) as unknown as Array<Record<string, unknown>>;
  bindPlanExternalInputs(tasks, externalInputs);
  assertPlanDataflow(tasks, {
    telegramIntent: detectTelegramDeliveryIntent(goal),
    outputLanguage: detectOutputLanguage(goal),
    external_input_artifacts: externalInputs,
  });
  return tasks;
}

function errCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return String((e as { code?: string }).code ?? e);
  }
}

const deliveryTasks = (tasks: Array<Record<string, unknown>>) =>
  tasks.filter((t) => isDeliveryTask(t));

/** Minimal TRUE-intent goal: the only clause is a delivery clause, so
 *  the goal contract extracts zero non-delivery obligations — used
 *  where coverage is not the property under test. */
const SIMPLE_TRUE_GOAL = "gửi tóm tắt kết quả lên Telegram";

/* ================= BUG 4 — before / after ================= */

describe("HOTFIX-D — delegated template path delivery planning", () => {
  it("R0. BEFORE: pre-fix template shape (goal embedded, no injection) reproduces FAIL_CLOSED_DELIVERY_TASK_MISSING", () => {
    // The pre-fix template list byte-for-byte: bookkeeping + T2 carrying
    // the operator goal embedded verbatim, zero delivery tasks — exactly
    // what the planner returned to runPlanning on the failed mission.
    const preFixTasks = [
      canonicalBookkeepingTask(BUG4_GOAL),
      {
        task_key: "T2",
        title: "llm analysis (dsh)",
        task_instruction:
          `The workspace contains mission_goal.txt holding the operator's goal: "${BUG4_GOAL}". ` +
          "Produce a genuine deliverable for that goal's subject matter — analyze the topic itself " +
          "(never just restate or describe the goal) — write findings to analysis.txt, then reply DONE.",
        required_capabilities: ["REASONING"],
        depends_on: ["T1"],
        metadata: {},
      },
    ];
    // The committed-plan gate the mission died on.
    expect(
      errCode(() =>
        assertPlanDataflow(preFixTasks as Array<Record<string, unknown>>, {
          telegramIntent: detectTelegramDeliveryIntent(BUG4_GOAL),
          outputLanguage: detectOutputLanguage(BUG4_GOAL),
          external_input_artifacts: [],
        }),
      ),
    ).toBe("FAIL_CLOSED_DELIVERY_TASK_MISSING");
  });

  it("R0'. AFTER: delegated mission with TRUE delivery intent commits a plan containing exactly one canonical delivery task", () => {
    const { planner } = makeServePlanner(deps());
    const proposal = planner(delegatedInput(BUG4_GOAL));
    const tasks = runPlanningChain(proposal, BUG4_GOAL);
    const deliv = deliveryTasks(tasks);
    expect(deliv.length).toBe(1);
    expect(tasks.map((t) => String(t.task_key))).toEqual(["T1", "T2", "T3"]);
  });

  it("R1. injected task is canonical — stamp, manifest, contract, language, staging-only instruction, producer edge", () => {
    const { planner } = makeServePlanner(deps());
    const tasks = runPlanningChain(
      planner(delegatedInput(BUG4_GOAL)),
      BUG4_GOAL,
    );
    const t3 = deliveryTasks(tasks)[0];
    expect(String(t3.task_key)).toBe("T3");
    expect(t3.required_capabilities).toEqual(["TELEGRAM_DELIVERY"]);
    // PAIR-owned injection evidence — the ONLY delivery authority.
    const inj = (t3.metadata as Record<string, unknown>)[
      PAIR_DELIVERY_INJECTION_KEY
    ] as Record<string, unknown>;
    expect(String(inj.reason)).toBe("DELIVERY_TASK_INJECTED");
    expect(String(inj.authority)).toBe("OPERATOR_TELEGRAM_INTENT");
    // Governed manifest stamped by reconcile.
    const manifest = (t3.metadata as Record<string, unknown>)[
      TELEGRAM_MANIFEST_FIELD
    ] as Record<string, unknown>;
    expect(manifest.requested).toBe(true);
    expect(String(manifest.mode)).toBe("TEXT");
    // Plan-contract + output-language authority derived from the goal.
    expect(
      (t3.metadata as Record<string, unknown>)[PAIR_PLAN_CONTRACT_KEY],
    ).toEqual({ version: 2 });
    const lang = (t3.metadata as Record<string, unknown>)[
      PAIR_OUTPUT_LANGUAGE_KEY
    ] as Record<string, unknown>;
    expect(String(lang.code)).toBe("vi");
    // Canonical staging instruction — the task prepares, the bridge sends.
    const instr = String(t3.task_instruction);
    expect(instr).toContain("governed TELEGRAM_DELIVERY preparation step");
    expect(instr).toContain("governed bridge performs the external delivery");
    expect(instr).toContain("Do NOT call Telegram");
    // Dataflow edge: the delivery task consumes the content-bearing
    // producer's RESULT_TEXT — a DAG leaf depending on T2.
    expect(t3.depends_on).toEqual(["T2"]);
  });

  it("R2. delivery task is a DAG leaf — nothing may depend on it", () => {
    const { planner } = makeServePlanner(deps());
    const tasks = runPlanningChain(
      planner(delegatedInput(BUG4_GOAL)),
      BUG4_GOAL,
    );
    const delivKey = String(deliveryTasks(tasks)[0].task_key);
    for (const t of tasks) {
      if (isDeliveryTask(t)) continue;
      expect((t.depends_on as string[]) ?? []).not.toContain(delivKey);
    }
  });

  it("R3. every non-delivery task passes the pre-dispatch semantic gate (the old embedded-goal instruction would have failed it)", () => {
    const { planner } = makeServePlanner(deps());
    const tasks = runPlanningChain(
      planner(delegatedInput(BUG4_GOAL)),
      BUG4_GOAL,
    );
    for (const t of tasks) {
      expect(errCode(() => assertTaskDeliverySemantic(t))).toBeNull();
    }
    // And the template instruction carries no delivery semantics itself.
    const t2 = tasks.find((t) => String(t.task_key) === "T2")!;
    expect(detectTelegramDeliveryIntent(String(t2.task_instruction)).requested).toBe(false);
    expect(String(t2.task_instruction)).not.toContain(BUG4_GOAL);
  });

  it("R4. FALSE intent — production nouns 'bài đăng' / 'lịch đăng' / 'đăng ký' inject zero delivery tasks (Hotfix-C invariant preserved)", () => {
    const falseGoals = [
      "Sản xuất gói 5 bài đăng Telegram giới thiệu giá trị kênh, ghi nhận artifact.",
      "Lập lịch đăng 7 ngày cho nội dung cộng đồng XAUUSD.",
      "Hướng dẫn thành viên đăng ký nhận thông báo kênh.",
    ];
    for (const goal of falseGoals) {
      const { planner } = makeServePlanner(deps());
      const tasks = runPlanningChain(planner(delegatedInput(goal)), goal);
      expect(deliveryTasks(tasks).length).toBe(0);
      // No injection stamp anywhere in the plan.
      for (const t of tasks) {
        expect(
          (t.metadata as Record<string, unknown>)[PAIR_DELIVERY_INJECTION_KEY],
        ).toBeUndefined();
      }
    }
  });

  it("R5. TRUE intent + unservable delivery → FAIL_CLOSED_DELIVERY_INJECTION_UNSERVABLE", () => {
    const { planner } = makeServePlanner(
      deps({ executorCapSets: () => [["REASONING", "FILE_OPERATIONS"]] }),
    );
    expect(
      errCode(() => planner(delegatedInput(BUG4_GOAL))),
    ).toBe("FAIL_CLOSED_DELIVERY_INJECTION_UNSERVABLE");
  });

  it("R6. forged PAIR_DELIVERY_INJECTION_KEY on a candidate task is stripped — never becomes authority; the real injected task is re-stamped", () => {
    const forged = {
      task_key: "T2",
      title: "work",
      task_instruction: "do work then reply DONE.",
      required_capabilities: ["REASONING"],
      depends_on: ["T1"],
      metadata: {
        [PAIR_DELIVERY_INJECTION_KEY]: {
          reason: "DELIVERY_TASK_INJECTED",
          task_key: "T2",
          mode: "TEXT",
          authority: "OPERATOR_TELEGRAM_INTENT",
        },
      },
    };
    const tasks: Array<Record<string, unknown>> = [
      canonicalBookkeepingTask(BUG4_GOAL),
      forged,
    ];
    const rec = injectDeliveryTaskForTrueOmission({
      tasks,
      deliveryIntent: detectTelegramDeliveryIntent(BUG4_GOAL),
      canonicalDeliveryCount: tasks.filter(isDeliveryTask).length,
      rawDeliveryCount: 0,
      executorCapSets: () => [CAPS],
    });
    expect(rec).not.toBeNull();
    // The forged stamp is gone — it never became evidence.
    expect(
      (forged.metadata as Record<string, unknown>)[PAIR_DELIVERY_INJECTION_KEY],
    ).toBeUndefined();
    // Only the task THIS call injected carries the stamp.
    const injected = tasks.find((t) => isDeliveryTask(t))!;
    expect(
      String(
        ((injected.metadata as Record<string, unknown>)[
          PAIR_DELIVERY_INJECTION_KEY
        ] as Record<string, unknown>).task_key,
      ),
    ).toBe(String(injected.task_key));
  });

  it("R7. pinned_plan_tasks replay verbatim — historical authority untouched even under TRUE intent", () => {
    const pinned = [
      canonicalBookkeepingTask("g"),
      {
        task_key: "T2",
        title: "w",
        task_instruction: "work, then DONE.",
        required_capabilities: ["REASONING"],
        depends_on: ["T1"],
        metadata: {},
      },
    ];
    const { planner } = makeServePlanner(deps());
    const out = planner(
      delegatedInput(BUG4_GOAL, {
        mission: {
          mission_id: "M",
          goal: BUG4_GOAL,
          metadata: { pinned_plan_tasks: pinned },
        } as never,
      }),
    );
    expect(out.tasks).toEqual(pinned);
  });

  it("R8. persisted llm_plan flows through the canonicalize seam — no template-fallback injection drift", () => {
    const FALSE_GOAL = "phân tích dữ liệu địa phương";
    const persisted = [
      {
        task_key: "T2",
        title: "analysis",
        // Instruction carries the goal's obligation verbatim so the
        // canonical coverage authority is satisfied — as a real
        // planner-emitted task would.
        task_instruction:
          "phân tích dữ liệu địa phương, then write analysis.txt, then reply DONE.",
        required_capabilities: ["REASONING"],
        depends_on: ["T1"],
        metadata: {},
      },
    ];
    const { planner } = makeServePlanner(deps());
    // A persisted plan for a FALSE-intent goal: replays through the seam
    // (provenance=persisted ⇒ injection never fires), no delivery task.
    const out = planner(
      delegatedInput(FALSE_GOAL, {
        mission: {
          mission_id: "M",
          goal: FALSE_GOAL,
          metadata: { llm_plan: persisted },
        } as never,
      }),
    );
    expect(deliveryTasks(out.tasks as Array<Record<string, unknown>>).length).toBe(0);
  });

  it("R9. replan without provider → FAIL_CLOSED_REPLAN_PROVIDER_UNAVAILABLE — no injection attempted on stored plans", () => {
    const { planner } = makeServePlanner(deps({ replanProvider: null }));
    expect(
      errCode(() =>
        planner(
          delegatedInput(BUG4_GOAL, {
            reason: "replan",
            replan_context: { recovery_id: "RCV_1" } as never,
          }),
        ),
      ),
    ).toBe("FAIL_CLOSED_REPLAN_PROVIDER_UNAVAILABLE");
  });

  it("R10. replan with a provider: candidate goes through THE SAME canonicalize seam — TRUE intent + omission still injects exactly one", () => {
    // Minimal TRUE-intent goal whose contract carries zero non-delivery
    // obligations (the delivery clause is skipped by contract
    // extraction) — keeps focus on the injection parity, not coverage.
    const replanProvider = () => ({
      tasks: [
        {
          task_key: "T2",
          title: "retry analysis",
          task_instruction: "analyze the subject then write analysis.txt, then reply DONE.",
          required_capabilities: ["REASONING"],
          depends_on: ["T1"],
          metadata: {},
        },
      ],
    });
    const { planner } = makeServePlanner(deps({ replanProvider }));
    const out = planner(
      delegatedInput(SIMPLE_TRUE_GOAL, {
        reason: "replan",
        replan_context: { recovery_id: "RCV_1" } as never,
      }),
    );
    const deliv = deliveryTasks(out.tasks as Array<Record<string, unknown>>);
    expect(deliv.length).toBe(1);
    expect(
      String(
        ((deliv[0].metadata as Record<string, unknown>)[
          PAIR_DELIVERY_INJECTION_KEY
        ] as Record<string, unknown>).reason,
      ),
    ).toBe("DELIVERY_TASK_INJECTED");
  });

  it("R11. cross-mission external inputs thread through reconcile on the injected path — binding, edges and manifest stay canonical", () => {
    const external: ExternalInputArtifactSource = {
      contract: EXTERNAL_INPUT_CONTRACT,
      artifact_id: "ART_SRC_1",
      logical_name: "analysis.txt",
      sha256: "a".repeat(64),
      byte_size: 128,
      source_mission_id: "MSN_PRODUCER",
      source_task_id: "TSK_PRODUCER",
      source_governed_task_id: "GTSK_PRODUCER",
      source_execution_id: "EXE_PRODUCER",
      source_executor_id: "EX_PRODUCER",
    };
    const { planner } = makeServePlanner(deps());
    const out = planner(
      delegatedInput(BUG4_GOAL, { input_artifact_sources: [external] }),
    );
    // Injected plan still commits through the exact runtime chain with
    // the eligible set re-proven at the boundary.
    const tasks = runPlanningChain(out, BUG4_GOAL, [external]);
    const t3 = deliveryTasks(tasks)[0];
    expect(
      (t3.metadata as Record<string, unknown>)[TELEGRAM_MANIFEST_FIELD],
    ).toMatchObject({ requested: true, mode: "TEXT" });
  });

  it("R12. the committed plan carries a routable delivery task — TELEGRAM_DELIVERY inside work vocabulary and servable by a qualified executor set", () => {
    const { planner } = makeServePlanner(deps());
    const tasks = runPlanningChain(
      planner(delegatedInput(BUG4_GOAL)),
      BUG4_GOAL,
    );
    const t3 = deliveryTasks(tasks)[0];
    // Capability is canonical (validatePlanProposal already required it
    // against knownCaps above); routability was proven at injection by
    // the servable check — an executor set carrying TELEGRAM_DELIVERY.
    expect(t3.required_capabilities).toEqual(["TELEGRAM_DELIVERY"]);
    const capSets = deps().executorCapSets();
    expect(
      capSets.some((set) => set.includes("TELEGRAM_DELIVERY")),
    ).toBe(true);
    // The canonical instruction never grants the executor send
    // authority — governed bridge authorization remains the only path.
    expect(String(t3.task_instruction)).toContain(
      "you have no such authority or tool",
    );
  });

  it("R13. shared-injection parity — canonicalize seam and template path mint identical injection evidence", () => {
    const { planner, canonicalizeLlmTasks } = makeServePlanner(deps());
    // Via canonicalize (fresh emission) — same minimal TRUE-intent goal
    // (zero non-delivery obligations) so coverage stays out of scope:
    const viaCanon = canonicalizeLlmTasks(
      [
        {
          task_key: "T2",
          title: "analysis",
          task_instruction:
            "analyze the subject then write analysis.txt, then reply DONE.",
          required_capabilities: ["REASONING"],
          depends_on: ["T1"],
          metadata: {},
        },
      ],
      SIMPLE_TRUE_GOAL,
      { external_input_artifacts: [] },
    );
    // Via template fallback — the REAL BUG-4 goal:
    const viaTemplate = planner(delegatedInput(BUG4_GOAL)).tasks as Array<
      Record<string, unknown>
    >;
    const stampOf = (ts: Array<Record<string, unknown>>) =>
      deliveryTasks(ts).map(
        (t) =>
          ((t.metadata as Record<string, unknown>)[
            PAIR_DELIVERY_INJECTION_KEY
          ] as Record<string, unknown>).reason,
      );
    expect(stampOf(viaCanon)).toEqual(["DELIVERY_TASK_INJECTED"]);
    expect(stampOf(viaTemplate)).toEqual(["DELIVERY_TASK_INJECTED"]);
    expect(deliveryTasks(viaCanon).length).toBe(1);
    expect(deliveryTasks(viaTemplate).length).toBe(1);
  });
});

/* ==================== R1 AUDIT — evidence gaps F1/F2/F3 ==================== */

/**
 * AUDIT FOLLOW-UP R1 — three evidence gaps closed test-side only:
 *  F1 — full integration: delegated mission planning (template fallback
 *       + injection) → governed dispatch → assertDeliveryDeliverable →
 *       mint → governed bridge transport against a RECORDING fake
 *       (authorization callback + durable receipt proven, zero real send).
 *  F2 — cross-mission dataflow: external artifact source binding,
 *       consumed artifacts, producer edges, manifest and post-validation
 *       plan integrity asserted field-by-field.
 *  F3 — forged PAIR_DELIVERY_INJECTION_KEY through the REAL
 *       canonicalizeLlmTasks seam, never the helper in isolation.
 */

const F1_CAPS = [
  "AUTOMATON_TASK_EXECUTION",
  "FILE_OPERATIONS",
  "REASONING",
  "TELEGRAM_DELIVERY",
];

/** Minimal production-shaped adapter: dispatches every task, writes the
 *  files its dataflow `produces` declares, declares those bytes back as
 *  canonical result artifacts through collect_result — the REAL ingest
 *  seam the delivery gate consumes. */
class F1Adapter implements ExecutorAdapter {
  readonly executor_id: string;
  caps: string[];
  dispatched: string[] = [];
  behavior: Record<string, "COMPLETE" | "WRITE"> = {};
  fileContent: Record<string, string> = {};
  workspace = "";
  store?: PairEvidenceStore;
  private wrote: Record<string, string[]> = {};
  private collected: Record<string, Record<string, unknown>> = {};

  constructor(id: string, caps: string[]) {
    this.executor_id = id;
    this.caps = caps;
  }
  probe() {
    return { executor_id: this.executor_id, available: true, state: "READY" };
  }
  qualify() {
    return { qualified: true, dispatch_enabled: true };
  }
  capabilities() {
    return { capability_ids: this.caps };
  }
  health() {
    return { state: "READY" };
  }
  prepare_task(task: Record<string, unknown>) {
    return task;
  }
  dispatch(task: Record<string, unknown>) {
    const eid = `EXEC_${this.executor_id}_${this.dispatched.length}`;
    this.dispatched.push(eid);
    // The governed-task payload carries task_id, not task_key — resolve
    // the canonical task row for the key (production adapters do this).
    const taskRow = this.store?.tryGet("task", String(task.task_id)) as
      | Record<string, unknown>
      | undefined;
    const key = String(taskRow?.task_key ?? "");
    // An honest executor produces every declared output — consumers of
    // produced artifacts resolve them through canonical ingest. (Skipping
    // produces makes downstream consumes unbound → DEPENDENCY_FAILURE.)
    if (this.workspace) {
      const df = (taskRow?.metadata as Record<string, unknown> | undefined)
        ?.pair_dataflow as Record<string, unknown> | undefined;
      for (const f of (df?.produces as string[]) ?? []) {
        const fp = path.join(this.workspace, f);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, this.fileContent[key] ?? `content of ${f}`);
        (this.wrote[eid] ??= []).push(f);
      }
    }
    this.collected[eid] = {
      status: "COMPLETED",
      mission_id: task.mission_id,
      task_id: task.task_id,
      governed_task_id: task.governed_task_id,
      summary: `done ${key}`,
    };
    return { execution_id: eid, status: "RUNNING", run_root: null };
  }
  observe(executionId: string) {
    return { status: String(this.collected[executionId]?.status ?? "RUNNING") };
  }
  cancel() {
    return { status: "CANCELLED" };
  }
  collect_result(executionId: string) {
    const r = this.collected[executionId] ?? {
      status: "FAILED",
      error: { class: "MISSING" },
    };
    const artifacts = (this.wrote[executionId] ?? [])
      .map((f) => {
        const fp = path.join(this.workspace, f);
        if (!fs.existsSync(fp)) return null;
        const bytes = fs.readFileSync(fp);
        return { path: f, sha256: sha256Hex(bytes), byte_size: bytes.length };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);
    return { execution_id: executionId, artifacts, ...r };
  }
  collect_artifacts() {
    return [] as Array<Record<string, unknown>>;
  }
}

const F1_VI_TEXT =
  "Bản tóm tắt thị trường XAUUSD.\n" +
  "Giá vàng biến động mạnh trong tuần qua với xu hướng tăng ngắn hạn.\n" +
  "Nguồn dữ liệu đã được kiểm chứng trước khi đăng.";

/** A full governed stack whose ONLY planner is the production
 *  makeServePlanner — the delegated mission carries no pinned plan and
 *  no llm_plan, so planning takes the template-fallback injection path
 *  end-to-end for real. */
function f1Stack(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pair-hotfixd-f1-${name}-`));
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const adapters = new Map<string, ExecutorAdapter>();
  const { planner } = makeServePlanner({
    hasExecutor: () => true,
    executorCapSets: () => [F1_CAPS],
  });
  const runtime = new MissionRuntime({
    service, gate, router, adapters: adapters as never, scheduler,
    approvals, reconciliation: recon, recovery, planner: planner as never,
    telegramDeliveryDefaultChatId: "111",
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: new MissionObservability(service),
    planner: planner as never,
  });
  for (const cap of F1_CAPS) {
    service.registerCapability(cap, { risk_class: "LOW" });
  }
  const projectId = String(
    service.createProject({ name, root_location: workspace }).project_id,
  );
  return {
    dir, workspace, store, service, gate, registry, router, recovery,
    recon, approvals, scheduler, runtime, supervisor, control, adapters,
    projectId,
  };
}

function f1RegisterAdapter(
  ctx: ReturnType<typeof f1Stack>,
  adapter: F1Adapter,
) {
  adapter.workspace = ctx.workspace;
  adapter.store = ctx.store;
  ctx.registry.register({
    executor_id: adapter.executor_id,
    executor_type: "EXTERNAL",
    capabilities: adapter.caps,
    health_state: "READY",
    status: "ENABLED",
    metadata: {
      routing_priority: 50,
      transport_type: TRANSPORT_IN_PROCESS,
      qualification_state: "QUALIFIED",
      permission_modes: ["READ", "WRITE", "FILE_READ", "FILE_WRITE"],
      workspace_modes: ["EXPLICIT_WORKSPACE"],
      supports_cancel: true,
      max_concurrency: 4,
    },
  });
  const routeId = `RTE_${adapter.executor_id}`;
  ctx.service.routes.registerRoute({
    route_id: routeId,
    route_kind: "IN_PROCESS_RUNTIME",
    enabled: true,
    eligibility_state: "QUALIFIED",
    qualification_state: "QUALIFIED",
    direct_callable: true,
    capabilities: adapter.caps,
    priority: 50,
    executor_hint: adapter.executor_id,
  });
  ctx.service.routes.registerBinding({
    executor_id: adapter.executor_id,
    route_id: routeId,
    mechanism: "SPAWN_ENV",
    qualification_state: "QUALIFIED",
    capabilities: adapter.caps,
  });
  ctx.adapters.set(adapter.executor_id, adapter);
}

function f1Drive(ctx: ReturnType<typeof f1Stack>, mid: string, max = 160) {
  let t = Date.parse("2026-01-01T00:00:00Z");
  for (let i = 0; i < max; i++) {
    t += 120_000;
    ctx.runtime.tick(mid, new Date(t).toISOString());
    const s = String(
      (ctx.store.get("mission_runtime", `MRT_${mid}`) as Record<
        string,
        unknown
      >).state,
    );
    if (
      ["COMPLETED", "FAILED", "ABORTED", "WAITING_APPROVAL", "CANCELLED"]
        .includes(s)
    ) {
      return s;
    }
  }
  return "TIMEOUT";
}

const f1Deliveries = (ctx: ReturnType<typeof f1Stack>) =>
  ctx.store.list("telegram_delivery_request");
const f1Evidence = (
  ctx: ReturnType<typeof f1Stack>,
  mid: string,
  kind: string,
) =>
  ctx.store.listEvidence(mid).filter((e) => String(e.kind) === kind);

interface F1SendCall {
  chatId: string;
  text?: string;
  filePath?: string;
  fileBytes?: Uint8Array;
  name?: string;
}
function f1RecordingTransport() {
  const calls: F1SendCall[] = [];
  const transport: GovernedTelegramTransport = {
    send: async (a: F1SendCall): Promise<GovernedSendResult> => {
      calls.push({ ...a });
      return { kind: "ok", message_id: 4242 };
    },
  };
  return { calls, transport };
}

function f1Backend(ctx: ReturnType<typeof f1Stack>, req: Record<string, unknown>) {
  const t = (artifact: string | null | undefined, body: Record<string, unknown>) =>
    ctx.control.transitionTelegramDelivery(String(req.delivery_id), {
      artifact,
      ...body,
    });
  const backend: DeliveryBackend = {
    begin: (a) => {
      const r = t(a, { to: "SENDING" }) as { acquired: boolean };
      return { acquired: r.acquired === true };
    },
    sent: (a, ev) => t(a, { to: "SENT", message_id: ev?.message_id ?? null }),
    failed: (a, err) => t(a, { to: "FAILED", error: err }),
    unknown: (a, err) => t(a, { to: "UNKNOWN", error: err }),
    unsendable: (reason) => t(null, { to: "UNSENDABLE", error: reason }),
  };
  return backend;
}

describe("HOTFIX-D R1 — audit evidence gaps", () => {
  it("F1. delegated TRUE-intent mission runs planning→dispatch→mint→governed bridge end-to-end: authorization consulted, canonical payload sent, durable receipt minted — zero real network", async () => {
    const ctx = f1Stack("send");
    const adapter = new F1Adapter("EX_D", F1_CAPS);
    // The injected T3 composes outbox/report.txt (DELIVERY_TEXT_ARTIFACT)
    // exactly as its canonical instruction prescribes.
    adapter.behavior = { T3: "WRITE" };
    adapter.fileContent = { T3: F1_VI_TEXT };
    f1RegisterAdapter(ctx, adapter);
    const m = ctx.control.startMission({
      project_id: ctx.projectId,
      goal: BUG4_GOAL,
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
      metadata: {}, // delegated shape — no pinned_plan_tasks, no llm_plan
    });
    const mid = String(m.mission_id);
    expect(f1Drive(ctx, mid)).toBe("COMPLETED");

    // The plan that committed came from the template+injection path:
    // exactly one delivery task T3 was dispatched and settled.
    const tasks = ctx.store
      .list("task")
      .filter((t) => String(t.mission_id) === mid);
    const t3 = tasks.find(
      (t) =>
        (t.required_capabilities as string[]).includes("TELEGRAM_DELIVERY"),
    )!;
    expect(String(t3.status)).toBe("COMPLETED");
    expect(
      String(
        ((t3.metadata as Record<string, unknown>)[
          PAIR_DELIVERY_INJECTION_KEY
        ] as Record<string, unknown>).reason,
      ),
    ).toBe("DELIVERY_TASK_INJECTED");

    // Governed mint: exactly one canonical send authorization, TEXT mode,
    // payload = the staged artifact bytes, provenance bound.
    const reqs = f1Deliveries(ctx);
    expect(reqs).toHaveLength(1);
    const req = reqs[0]!;
    expect(String(req.mode)).toBe("TEXT");
    // VALIDATED === SENT: the persisted payload digests itself and
    // carries the staged Vietnamese content end-to-end.
    const reqText = String(req.text);
    expect(reqText).toContain("Bản tóm tắt thị trường XAUUSD");
    expect(String(req.text_sha256)).toBe(digest(reqText));
    expect(Number(req.text_length)).toBe(reqText.length);
    expect(String(req.text_source_artifact)).toBe("outbox/report.txt");
    expect(
      f1Evidence(ctx, mid, TELEGRAM_DELIVERY_MINTED).length,
    ).toBeGreaterThan(0);

    // Governed bridge pass — a recording transport, never real Telegram.
    const rec = f1RecordingTransport();
    const allowed: string[] = [];
    const pending = pendingTelegramDeliveries(ctx.store) as Array<
      Record<string, unknown>
    >;
    expect(pending).toHaveLength(1);
    const r = await transportTelegramDelivery({
      request: pending[0]!,
      transport: rec.transport,
      isAllowed: (chatId: string) => {
        allowed.push(chatId);
        return chatId === "111"; // allowlist semantics under test
      },
      backend: f1Backend(ctx, pending[0]!),
      readText: (p) => fs.readFileSync(p, "utf8"),
    });
    // Authorization WAS consulted for the bound destination.
    expect(allowed).toEqual(["111"]);
    // Exactly one send, the canonical payload, to the bound chat.
    expect(r.sent).toEqual([`TEXT:${String(req.delivery_id)}`]);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.chatId).toBe("111");
    expect(String(rec.calls[0]!.text)).toContain(
      "Bản tóm tắt thị trường XAUUSD",
    );
    // Durable receipt: request SENT with acceptance message_id and the
    // immutable attempt ledger records STARTED→RESOLVED(SENT).
    const after = ctx.store.get(
      "telegram_delivery_request",
      String(req.delivery_id),
    );
    expect(String(after.status)).toBe("SENT");
    expect(Number(after.message_id)).toBe(4242);
    expect(
      f1Evidence(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_STARTED).length,
    ).toBeGreaterThan(0);
    const resolved = f1Evidence(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_RESOLVED);
    expect(resolved.length).toBeGreaterThan(0);
    expect(
      String(
        (resolved[0]!.payload as Record<string, unknown>).outcome ??
          JSON.stringify(resolved[0]!.payload),
      ),
    ).toContain("SENT");
    // Idempotent: a second projection pass sends nothing.
    const again = pendingTelegramDeliveries(ctx.store);
    expect(again).toHaveLength(0);
  });

  it("F1b. the same request through a DENYING authorization gate → unsendable, zero transport calls", async () => {
    const ctx = f1Stack("deny");
    const adapter = new F1Adapter("EX_D", F1_CAPS);
    adapter.behavior = { T3: "WRITE" };
    adapter.fileContent = { T3: F1_VI_TEXT };
    f1RegisterAdapter(ctx, adapter);
    const m = ctx.control.startMission({
      project_id: ctx.projectId,
      goal: BUG4_GOAL,
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [ctx.workspace],
      metadata: {},
    });
    const mid = String(m.mission_id);
    expect(f1Drive(ctx, mid)).toBe("COMPLETED");
    const pending = pendingTelegramDeliveries(ctx.store) as Array<
      Record<string, unknown>
    >;
    expect(pending).toHaveLength(1);
    const rec = f1RecordingTransport();
    const r = await transportTelegramDelivery({
      request: pending[0]!,
      transport: rec.transport,
      isAllowed: () => false, // destination denied — bridge must hold
      backend: f1Backend(ctx, pending[0]!),
      readText: (p) => fs.readFileSync(p, "utf8"),
    });
    expect(r.sent).toEqual([]);
    expect(r.held).toBe(true);
    expect(rec.calls).toHaveLength(0);
    const after = ctx.store.get(
      "telegram_delivery_request",
      String(pending[0]!.delivery_id),
    );
    expect(String(after.status)).toBe("UNSENDABLE");
    expect(
      f1Evidence(ctx, mid, TELEGRAM_DELIVERY_ATTEMPT_RESOLVED).length,
    ).toBe(0);
  });

  it("F2. cross-mission external input through the injected path — binding provenance, consumed artifact, producer edges, manifest and post-validation integrity", () => {
    const external: ExternalInputArtifactSource = {
      contract: EXTERNAL_INPUT_CONTRACT,
      artifact_id: "ART_SRC_1",
      logical_name: "producer_report.txt",
      sha256: "a".repeat(64),
      byte_size: 128,
      source_mission_id: "MSN_PRODUCER",
      source_task_id: "TSK_PRODUCER",
      source_governed_task_id: "GTSK_PRODUCER",
      source_execution_id: "EXE_PRODUCER",
      source_executor_id: "EX_PRODUCER",
    };
    // A planner-emitted consumer whose instruction references the
    // external artifact by canonical logical name — the REAL
    // canonicalize seam derives the consume and stamps the binding.
    const { canonicalizeLlmTasks } = makeServePlanner(deps());
    const out = canonicalizeLlmTasks(
      [
        {
          task_key: "T2",
          title: "verify input",
          task_instruction:
            "read producer_report.txt, verify it, write analysis.txt, then reply DONE.",
          required_capabilities: ["REASONING"],
          depends_on: ["T1"],
          metadata: {},
        },
      ],
      SIMPLE_TRUE_GOAL,
      { external_input_artifacts: [external] },
    ) as Array<Record<string, unknown>>;

    // Source binding: the consuming task carries the full provenance
    // ledger — artifact identity, digest and complete producer lineage.
    const t2 = out.find((t) => String(t.task_key) === "T2")!;
    const t2df = (t2.metadata as Record<string, unknown>)
      .pair_dataflow as Record<string, unknown>;
    expect(t2df.consumes).toEqual(["producer_report.txt"]);
    const stamps = (t2.metadata as Record<string, unknown>)[
      PAIR_DATAFLOW_SOURCES
    ] as Array<Record<string, unknown>>;
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toMatchObject({
      contract: EXTERNAL_INPUT_CONTRACT,
      consume_name: "producer_report.txt",
      artifact_id: "ART_SRC_1",
      logical_name: "producer_report.txt",
      sha256: "a".repeat(64),
      byte_size: 128,
      source_mission_id: "MSN_PRODUCER",
      source_task_id: "TSK_PRODUCER",
      source_governed_task_id: "GTSK_PRODUCER",
      source_execution_id: "EXE_PRODUCER",
      source_executor_id: "EX_PRODUCER",
    });

    // Producer edges: the injected delivery task still hangs off the
    // content-bearing producer — DAG: T1 → T2 → T3 (delivery leaf).
    const t3 = deliveryTasks(out)[0]!;
    expect(t3.depends_on).toEqual(["T2"]);
    const t3df = (t3.metadata as Record<string, unknown>)
      .pair_dataflow as Record<string, unknown>;
    expect(t3df.produces).toEqual(["outbox/report.txt"]);

    // Manifest: governed delivery manifest stamped on the injected task.
    const manifest = (t3.metadata as Record<string, unknown>)[
      TELEGRAM_MANIFEST_FIELD
    ] as Record<string, unknown>;
    expect(manifest).toMatchObject({ requested: true, mode: "TEXT" });

    // Post-validation integrity: the committed shape passes the SAME
    // boundary gate runPlanning applies — binding re-proven against the
    // live eligible set.
    assertPlanDataflow(out, {
      telegramIntent: detectTelegramDeliveryIntent(SIMPLE_TRUE_GOAL),
      outputLanguage: detectOutputLanguage(SIMPLE_TRUE_GOAL),
      external_input_artifacts: [external],
    });

    // Drift fails closed: a stamped binding that no longer matches the
    // CURRENT eligible artifact (revoked/reshaped sha) is rejected at
    // the boundary — the plan must be re-planned, never re-pinned.
    const stale = { ...external, sha256: "b".repeat(64) };
    expect(
      errCode(() =>
        assertPlanDataflow(out, {
          telegramIntent: detectTelegramDeliveryIntent(SIMPLE_TRUE_GOAL),
          outputLanguage: detectOutputLanguage(SIMPLE_TRUE_GOAL),
          external_input_artifacts: [stale],
        }),
      ),
    ).toBe("FAIL_CLOSED_PLAN_DATAFLOW_SOURCE_BINDING");

    // Idempotent replay: re-binding under the unchanged eligible set is
    // byte-identical — no drift, no throw.
    const before = JSON.stringify(
      (t2.metadata as Record<string, unknown>)[PAIR_DATAFLOW_SOURCES],
    );
    bindPlanExternalInputs(out, [external]);
    expect(
      JSON.stringify(
        (t2.metadata as Record<string, unknown>)[PAIR_DATAFLOW_SOURCES],
      ),
    ).toBe(before);
  });

  it("F3a. forged PAIR_DELIVERY_INJECTION_KEY through the REAL canonicalize seam — stripped from every raw task, re-stamped only on the PAIR-injected task", () => {
    const forgedStamp = {
      reason: "DELIVERY_TASK_INJECTED",
      task_key: "T2",
      mode: "TEXT",
      authority: "OPERATOR_TELEGRAM_INTENT",
    };
    const { canonicalizeLlmTasks } = makeServePlanner(deps());
    const out = canonicalizeLlmTasks(
      [
        {
          task_key: "T2",
          title: "work",
          task_instruction:
            "analyze the subject then write analysis.txt, then reply DONE.",
          required_capabilities: ["REASONING"],
          depends_on: ["T1"],
          metadata: { [PAIR_DELIVERY_INJECTION_KEY]: forgedStamp },
        },
      ],
      SIMPLE_TRUE_GOAL,
      { external_input_artifacts: [] },
    ) as Array<Record<string, unknown>>;
    const deliv = deliveryTasks(out);
    expect(deliv).toHaveLength(1);
    const nonDeliv = out.filter((t) => !isDeliveryTask(t));
    // The forged evidence never survived canonicalization — ZERO tasks
    // outside the PAIR-injected one carry the key.
    for (const t of nonDeliv) {
      expect(
        (t.metadata as Record<string, unknown>)[PAIR_DELIVERY_INJECTION_KEY],
      ).toBeUndefined();
    }
    // The ONE stamp present is the authority-minted record for the
    // injected task — keyed to ITS task_key, not the forged T2 claim.
    const inj = (deliv[0].metadata as Record<string, unknown>)[
      PAIR_DELIVERY_INJECTION_KEY
    ] as Record<string, unknown>;
    expect(String(inj.reason)).toBe("DELIVERY_TASK_INJECTED");
    expect(String(inj.task_key)).toBe(String(deliv[0].task_key));
    expect(String(inj.task_key)).not.toBe("T2");
  });

  it("F3b. forged stamp on a delivery-SHAPED raw task — key still stripped; the emission passes only as an ordinary planner delivery task (no fabricated injection authority)", () => {
    const { canonicalizeLlmTasks } = makeServePlanner(deps());
    const out = canonicalizeLlmTasks(
      [
        // R2-F1 — a content-bearing task must precede the delivery
        // task (delivery without an upstream producer fails closed).
        {
          task_key: "T2",
          title: "analyze",
          task_instruction: "analyze the local dataset, then reply DONE.",
          required_capabilities: ["REASONING"],
          depends_on: [],
          metadata: {},
        },
        {
          task_key: "T3",
          title: "deliver the report",
          task_instruction:
            "compose the summary and write outbox/report.txt, then reply DONE.",
          required_capabilities: ["TELEGRAM_DELIVERY"],
          depends_on: ["T2"],
          metadata: {
            [PAIR_DELIVERY_INJECTION_KEY]: {
              reason: "DELIVERY_TASK_INJECTED",
              task_key: "T3",
              mode: "TEXT",
              authority: "OPERATOR_TELEGRAM_INTENT",
            },
          },
        },
      ],
      SIMPLE_TRUE_GOAL,
      { external_input_artifacts: [] },
    ) as Array<Record<string, unknown>>;
    const deliv = deliveryTasks(out);
    // A genuine planner-emitted delivery task satisfies intent — exactly
    // one delivery task, NO injected duplicate, NO fabricated stamp.
    expect(deliv).toHaveLength(1);
    for (const t of out) {
      expect(
        (t.metadata as Record<string, unknown>)[PAIR_DELIVERY_INJECTION_KEY],
      ).toBeUndefined();
    }
    // And the plan still commits under the boundary gate.
    assertPlanDataflow(out, {
      telegramIntent: detectTelegramDeliveryIntent(SIMPLE_TRUE_GOAL),
      outputLanguage: detectOutputLanguage(SIMPLE_TRUE_GOAL),
      external_input_artifacts: [],
    });
  });
});

/* ================= R2 AUDIT FINDINGS =================
 *  F1 — TEXT delivery with ZERO content-bearing upstream must fail
 *       closed (requiredEdges shared by reconcile + assert seam).
 *  F2 — injected task key must be unique under skipped emission
 *       numbers (codex-only fallback emitted a literal "T3").
 *  F3 — the template fallback IS the delegated path: work tasks must
 *       declare eligible upstream artifacts as consumes through the
 *       canonical seams (instruction-derived consume →
 *       bindPlanExternalInputs → pair_dataflow → dispatch
 *       resolveForConsumer → materializeForConsumer), otherwise the
 *       cross-mission handoff silently never happens.
 */

describe("HOTFIX-D R2 — audit findings F1/F2/F3", () => {
  const PY_TRUE_GOAL =
    "viết script python phân tích dữ liệu rồi gửi tóm tắt kết quả lên Telegram";

  it("R2-F1a. TEXT delivery with no content-bearing producer FAILS CLOSED at planning — a delivery can never fabricate the payload", () => {
    // DSH + Codex both unavailable: template emits T1 only. TRUE intent
    // injects T2 delivery — but T2 has no upstream content.
    const { planner } = makeServePlanner(
      deps({ hasExecutor: () => false }),
    );
    expect(
      errCode(() => planner(delegatedInput(SIMPLE_TRUE_GOAL)) as never),
    ).toBe("FAIL_CLOSED_PLAN_DATAFLOW_UNBOUND_INPUT");
    // A stored delivery-only plan (exactly the shape the injected
    // authority would mint against a contentless task list) is rejected
    // at the PURE structural seam too — replay can never smuggle it.
    const withInjected = [canonicalBookkeepingTask(SIMPLE_TRUE_GOAL)] as
      Array<Record<string, unknown>>;
    injectDeliveryTaskForTrueOmission({
      tasks: withInjected,
      deliveryIntent: detectTelegramDeliveryIntent(SIMPLE_TRUE_GOAL),
      canonicalDeliveryCount: 0,
      rawDeliveryCount: 0,
      executorCapSets: () => [CAPS],
    });
    expect(deliveryTasks(withInjected)).toHaveLength(1);
    const replayCode = errCode(() =>
      assertPlanDataflow(withInjected as never[], {
        telegramIntent: detectTelegramDeliveryIntent(SIMPLE_TRUE_GOAL),
        outputLanguage: detectOutputLanguage(SIMPLE_TRUE_GOAL),
        external_input_artifacts: [],
      }),
    );
    // Rejected at the pure structural seam by a fail-closed gate —
    // the exact gate ordering is contract-internal; what matters is a
    // stored delivery-without-content plan can never reach dispatch.
    expect(replayCode?.startsWith("FAIL_CLOSED_")).toBe(true);
  });

  it("R2-F1b. single-producer and multi-producer TEXT delivery still plan canonically (legitimate delivery preserved)", () => {
    const { canonicalizeLlmTasks } = makeServePlanner(deps());
    const one = canonicalizeLlmTasks(
      [
        {
          task_key: "T2",
          title: "analyze",
          task_instruction: "analyze the local dataset, then reply DONE.",
          required_capabilities: ["REASONING"],
          depends_on: [],
          metadata: {},
        },
        {
          task_key: "T3",
          title: "deliver",
          task_instruction: "compose the summary, then reply DONE.",
          required_capabilities: ["TELEGRAM_DELIVERY"],
          depends_on: ["T2"],
          metadata: {},
        },
      ],
      SIMPLE_TRUE_GOAL,
      { external_input_artifacts: [] },
    ) as Array<Record<string, unknown>>;
    const d1 = deliveryTasks(one)[0]!;
    expect(d1.depends_on).toEqual(["T2"]);

    const two = canonicalizeLlmTasks(
      [
        {
          task_key: "T2",
          title: "collect",
          task_instruction: "collect local inputs, then reply DONE.",
          required_capabilities: ["REASONING"],
          depends_on: [],
          metadata: {},
        },
        {
          task_key: "T3",
          title: "compose",
          task_instruction: "write the digest file digest.md, then reply DONE.",
          required_capabilities: ["REASONING"],
          depends_on: ["T2"],
          metadata: {},
        },
        {
          task_key: "T4",
          title: "deliver",
          task_instruction: "compose the summary, then reply DONE.",
          required_capabilities: ["TELEGRAM_DELIVERY"],
          depends_on: ["T2", "T3"],
          metadata: {},
        },
      ],
      SIMPLE_TRUE_GOAL,
      { external_input_artifacts: [] },
    ) as Array<Record<string, unknown>>;
    const d2 = deliveryTasks(two)[0]!;
    // BOTH content-bearing upstreams bind RESULT_TEXT edges.
    expect(d2.depends_on).toEqual(["T2", "T3"]);
  });

  it("R2-F2a. DSH absent + codex emitted: the injected delivery key is unique and deterministic — T4, not a second T3", () => {
    const { planner } = makeServePlanner(
      deps({ hasExecutor: (id) => id === "CODEX" }),
    );
    const out = (planner(delegatedInput(PY_TRUE_GOAL)) as {
      tasks: Array<Record<string, unknown>>;
    }).tasks;
    expect(out.map((t) => String(t.task_key))).toEqual(["T1", "T3", "T4"]);
    const d = deliveryTasks(out)[0]!;
    expect(String(d.task_key)).toBe("T4");
    // The codex step is the sole content producer — delivery binds it.
    expect(d.depends_on).toEqual(["T3"]);
    const keys = out.map((t) => String(t.task_key));
    expect(new Set(keys).size).toBe(keys.length);
    runPlanningChain({ tasks: out }, PY_TRUE_GOAL);
  });

  it("R2-F2b. DSH + codex both present: emission T1,T2,T3 then injected T4 — ordering and leaf preserved", () => {
    const { planner } = makeServePlanner(deps());
    const out = (planner(delegatedInput(PY_TRUE_GOAL)) as {
      tasks: Array<Record<string, unknown>>;
    }).tasks;
    expect(out.map((t) => String(t.task_key))).toEqual(["T1", "T2", "T3", "T4"]);
    const d = deliveryTasks(out)[0]!;
    expect(String(d.task_key)).toBe("T4");
    expect(d.depends_on).toEqual(["T2", "T3"]);
    const keys = out.map((t) => String(t.task_key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("R2-F2c. replay determinism — same input emits the identical canonical list twice (no key drift, no duplicate injection)", () => {
    const { planner } = makeServePlanner(
      deps({ hasExecutor: (id) => id === "CODEX" }),
    );
    const a = (planner(delegatedInput(PY_TRUE_GOAL)) as {
      tasks: Array<Record<string, unknown>>;
    }).tasks;
    const b = (planner(delegatedInput(PY_TRUE_GOAL)) as {
      tasks: Array<Record<string, unknown>>;
    }).tasks;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(deliveryTasks(a)).toHaveLength(1);
  });

  /* ---- R2-F3: real delegated bound-mission handoff ---- */

  const F3_OP = "op:r2";
  let f3Seq = 0;

  /** Real business scope + workstream decomposition (production seams). */
  function f3Scope(ctx: ReturnType<typeof f1Stack>, wsKeys: string[]) {
    const businessId = `BIZ_R2_${f3Seq++}`;
    ctx.store.put("business", businessId, {
      business_id: businessId,
      name: "biz r2",
      status: "ACTIVE",
      currency: "USD",
      project_id: ctx.projectId,
      created_at: utcnow(),
      version: 0,
    }, 0);
    const schedules = new MissionScheduleService(ctx.service);
    const biz = new BusinessLayer({ store: ctx.store, control: ctx.control, schedules });
    const wf = new WorkforceService({ store: ctx.store, business: biz });
    const workstreams = new ObjectiveWorkstreamService(
      { store: ctx.store, business: biz, workforce: wf, objectives: biz.objectives });
    const alloc = new WorkforceAllocationService(
      { store: ctx.store, business: biz, workforce: wf, objectives: biz.objectives, workstreams });
    const obj = biz.objectives.create({
      business_id: businessId,
      title: "obj r2",
      statement: "grow r2",
      kpis: [{ name: "kpi", unit: "count", baseline: 0, target: 1 }],
      deadline: "2999-01-01T00:00:00.000Z",
      budget_ceiling_microusd: 500_000_000,
      hard_constraints: [],
      success_conditions: ["done"],
      dedup_key: `dk-r2-${f3Seq++}`,
      operator_id: F3_OP,
    });
    const objectiveId = String(obj.objective_id);
    workstreams.decomposeObjective({
      objective_id: objectiveId,
      expected_objective_version: Number(obj.version),
      expected_terms_version: Number(obj.terms_version),
      expected_objective_digest: String(obj.objective_digest),
      workstreams: wsKeys.map((k) => ({
        workstream_key: k, title: `ws ${k}`, goal: `g ${k}`,
      })) as never,
      actor: F3_OP,
    });
    biz.createOrgAgent({
      business_id: businessId,
      title: "agent r2",
      department: "ops",
      operator_id: F3_OP,
    });
    return { objectiveId, businessId, biz, alloc };
  }

  /** Real delegated mission: allocateWorkstream → delegated child →
   *  openWorkItem → WOB BOUND + mission mint (the exact production
   *  delegated path, never a hand-built mission row). */
  function f3BoundMission(
    ctx: ReturnType<typeof f1Stack>,
    scope: ReturnType<typeof f3Scope>,
    wsKey: string,
  ) {
    scope.alloc.allocateWorkstream({
      objective_id: scope.objectiveId,
      workstream_key: wsKey,
      actor: F3_OP,
    });
    const wal = ctx.store
      .list("workforce_allocation")
      .find(
        (r) =>
          String(r.objective_id) === scope.objectiveId &&
          String(r.workstream_key ?? "") === wsKey,
      )!;
    const childId = String(wal.delegated_child_work_item_id);
    scope.biz.openWorkItem(childId, F3_OP);
    const wob = ctx.store
      .list("work_open_binding")
      .find((b) => String(b.work_item_id) === childId)!;
    const missionId = String(wob.mission_id);
    // Govern the mission into the shared governed workspace so the
    // adapter + materialization share one root (production wiring does
    // the same via allocation workspace).
    const mission = ctx.store.get("mission", missionId);
    ctx.store.put(
      "mission",
      missionId,
      { ...mission, authorized_workspaces: [ctx.workspace] },
      Number(mission.version),
    );
    return { missionId, workItemId: childId };
  }

  /** Producer mission's ACCEPTED canonical artifact — full mint chain. */
  function f3AcceptedArtifact(
    ctx: ReturnType<typeof f1Stack>,
    missionId: string,
    name: string,
    bytes: Buffer,
  ) {
    const tid = `ATSK_R2_${f3Seq++}`;
    const gtId = `GT_${tid}`;
    const eid = workerExecutionId("EX_R2", gtId);
    ctx.store.put("task", tid, {
      task_id: tid, task_key: "TS1", mission_id: missionId,
      plan_id: "PLAN_A", title: "ts", task_instruction: `produce ${name}`,
      required_capabilities: ["FILE_OPERATIONS"], depends_on: [],
      status: "COMPLETED",
      metadata: { pair_dataflow: { produces: [name], consumes: [] } },
      version: 0,
    }, 0);
    ctx.store.put("governed_task", gtId, {
      governed_task_id: gtId, mission_id: missionId, task_id: tid,
      correlation_id: `COR_${tid}`, executor_id: "EX_R2",
      plan_id: "PLAN_A", plan_revision: 1,
      workspace: ctx.workspace, allowed_paths: [ctx.workspace],
      governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
      created_at: utcnow(), version: 0,
    }, 0);
    ctx.store.event({
      entity_type: "governed_task", entity_id: gtId,
      event_type: "GOVERNED_TASK_VALIDATED", new_state: "VALIDATED",
      actor: "PAIR_GOVERNED_TASK_GATE", correlation_id: `COR_${tid}`,
      metadata: {
        mission_id: missionId, task_id: tid, executor_id: "EX_R2",
        governed_task_id: gtId, plan_id: "PLAN_A", plan_revision: 1,
        remote_produces_contract: false,
        declared_produces: [name], declared_produces_digest: null,
      },
    });
    ctx.store.event({
      entity_type: "governed_task", entity_id: gtId,
      event_type: "EXECUTION_PREPARED", old_state: "VALIDATED",
      new_state: "DISPATCH_AUTHORIZED",
      actor: "PAIR_GOVERNED_TASK_GATE", correlation_id: `COR_${tid}`,
    });
    ctx.store.put("executor_dispatch_intent", `INTENT_${gtId}`, {
      intent_id: `INTENT_${gtId}`, governed_task_id: gtId,
      executor_id: "EX_R2", state: "EXECUTION_PERSISTED",
      execution_id: eid, created_at: utcnow(), version: 0,
    }, 0);
    fs.writeFileSync(path.join(ctx.workspace, name), bytes);
    ctx.store.put("executor_execution", eid, {
      execution_id: eid, governed_task_id: gtId, mission_id: missionId,
      task_id: tid, executor_id: "EX_R2", plan_revision: 1,
      correlation_id: `COR_${tid}`, execution_state: "COMPLETED",
      dispatch_timestamp: utcnow(), run_root: `${ctx.workspace}/run`,
      workspace: ctx.workspace,
      result: {
        status: "COMPLETED", output: "done",
        artifacts: [{ path: name, sha256: sha256Hex(bytes), byte_size: bytes.length }],
      },
      version: 0,
    }, 0);
    ctx.store.event({
      entity_type: "executor_execution", entity_id: eid,
      event_type: "EXECUTION_DISPATCHED", new_state: "COMPLETED",
      actor: "PAIR_GOVERNED_TASK_GATE", correlation_id: `COR_${tid}`,
      metadata: { governed_task_id: gtId },
    });
    ctx.store.event({
      entity_type: "executor_execution", entity_id: eid,
      event_type: "RESULT_COLLECTED", new_state: "COMPLETED",
      actor: "PAIR_GOVERNED_TASK_GATE", correlation_id: `COR_${tid}`,
    });
    const v = new ArtifactProvenanceValidator()
      .validate_execution(ctx.service, eid) as Record<string, unknown>;
    if (String(v.status) !== "PASS") {
      throw new Error(`fixture validation: ${JSON.stringify(v.failures)}`);
    }
    const art = ctx.store
      .list("artifact")
      .find((a) => String(a.logical_name) === name)!;
    return { artifactId: String(art.artifact_id), bytes, eid, tid, gtId };
  }

  it("R2-F3a. delegated bound mission consumes the upstream ACCEPTED artifact through the REAL template path — binding, provenance, dispatch resolution, byte materialization", () => {
    const ctx = f1Stack("f3a");
    const adapter = new F1Adapter("EX_R2", F1_CAPS);
    f1RegisterAdapter(ctx, adapter);
    const scope = f3Scope(ctx, ["w_src", "w_dst"]);
    const producer = f3BoundMission(ctx, scope, "w_src");
    const art = f3AcceptedArtifact(
      ctx, producer.missionId, "upstream-brief.md",
      Buffer.from("UPSTREAM CANONICAL BYTES"),
    );
    const consumer = f3BoundMission(ctx, scope, "w_dst");

    // Eligible set (the production resolver the runtime feeds the
    // planner) sees exactly the producer artifact.
    const sources = ctx.service.artifactResolver
      .listEligibleExternalInputSources(
        ctx.store.get("mission", consumer.missionId) as never,
      ) as Array<Record<string, unknown>>;
    expect(sources.map((s) => String(s.artifact_id))).toEqual([art.artifactId]);

    const state = f1Drive(ctx, consumer.missionId);
    expect(state).toBe("COMPLETED");

    // The consumer's T2 declared + bound the upstream artifact on the
    // real template path — the audit's missing evidence.
    const t2 = ctx.store
      .list("task")
      .find(
        (t) =>
          String(t.mission_id) === consumer.missionId &&
          String(t.task_key) === "T2",
      )!;
    expect(String(t2.task_instruction)).toContain("upstream-brief.md");
    const df = (t2.metadata as Record<string, unknown>)
      .pair_dataflow as Record<string, unknown>;
    expect(df.consumes).toContain("upstream-brief.md");
    expect(df.consumes).toContain("mission_goal.txt");
    const rows = (t2.metadata as Record<string, unknown>)[
      PAIR_DATAFLOW_SOURCES
    ] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.contract).toBe(EXTERNAL_INPUT_CONTRACT);
    expect(row.consume_name).toBe("upstream-brief.md");
    expect(row.artifact_id).toBe(art.artifactId);
    expect(row.logical_name).toBe("upstream-brief.md");
    expect(row.sha256).toBe(sha256Hex(art.bytes));
    expect(row.byte_size).toBe(art.bytes.length);
    expect(row.source_mission_id).toBe(producer.missionId);
    expect(row.source_task_id).toBe(art.tid);
    expect(row.source_governed_task_id).toBe(art.gtId);
    expect(row.source_execution_id).toBe(art.eid);

    // Dispatch resolution pinned the cross-mission dependency entry and
    // materialized the exact CAS bytes into the consumer workspace —
    // the downstream task receives the real upstream artifact, never
    // silently regenerated content.
    const materialized = path.join(
      ctx.workspace,
      ".pair/dependency-artifacts",
    );
    const found: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "upstream-brief.md") found.push(p);
      }
    };
    if (fs.existsSync(materialized)) walk(materialized);
    expect(found.length).toBe(1);
    expect(fs.readFileSync(found[0]!).equals(art.bytes)).toBe(true);
  });

  it("R2-F3b. revoked upstream source → dispatch re-proof fails closed (stale binding never spends)", () => {
    const ctx = f1Stack("f3b");
    const adapter = new F1Adapter("EX_R2", F1_CAPS);
    f1RegisterAdapter(ctx, adapter);
    const scope = f3Scope(ctx, ["w_src", "w_dst"]);
    const producer = f3BoundMission(ctx, scope, "w_src");
    const art = f3AcceptedArtifact(
      ctx, producer.missionId, "upstream-brief.md",
      Buffer.from("UPSTREAM"),
    );
    const consumer = f3BoundMission(ctx, scope, "w_dst");

    // Plan lands first (binding stamped), then revoke the source:
    // mutate the artifact row so the eligible set no longer contains
    // the pinned identity (sha drift = revocation class).
    const t = Date.parse("2026-01-01T00:00:00Z");
    let ticks = 0;
    // Drive just past planning: tick until T2 task exists or cap.
    for (let i = 0; i < 40; i++) {
      ticks++;
      ctx.runtime.tick(
        consumer.missionId,
        new Date(t + ticks * 120_000).toISOString(),
      );
      if (
        ctx.store.list("task").some(
          (x) =>
            String(x.mission_id) === consumer.missionId &&
            String(x.task_key) === "T2",
        )
      ) break;
    }
    const t2 = ctx.store
      .list("task")
      .find(
        (x) =>
          String(x.mission_id) === consumer.missionId &&
          String(x.task_key) === "T2",
      );
    expect(t2).toBeTruthy();
    // Revoke: the artifact's sha no longer equals the pinned binding.
    const artRow = ctx.store.get("artifact", art.artifactId);
    ctx.store.put(
      "artifact",
      art.artifactId,
      { ...artRow, sha256: "0".repeat(64) },
      Number(artRow.version),
    );
    // Stale binding is re-proven at dispatch — the consume resolution
    // fails closed (verification/revocation code) instead of spending
    // drifted bytes.
    const code = errCode(() => f1Drive(ctx, consumer.missionId, 160));
    expect(code.startsWith("FAIL_CLOSED_")).toBe(true);
    // T2 never completed — it could not lawfully consume.
    const t2Now = ctx.store.get("task", String(t2!.task_id));
    expect(String(t2Now.status)).not.toBe("COMPLETED");
  });

  it("R2-F3c. missing upstream source (empty eligible set) — no binding minted, template tasks carry no fabricated consume", () => {
    const ctx = f1Stack("f3c");
    const adapter = new F1Adapter("EX_R2", F1_CAPS);
    f1RegisterAdapter(ctx, adapter);
    const scope = f3Scope(ctx, ["w_src", "w_dst"]);
    f3BoundMission(ctx, scope, "w_src"); // produces nothing
    const consumer = f3BoundMission(ctx, scope, "w_dst");
    const sources = ctx.service.artifactResolver
      .listEligibleExternalInputSources(
        ctx.store.get("mission", consumer.missionId) as never,
      ) as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(0);
    const state = f1Drive(ctx, consumer.missionId);
    expect(state).toBe("COMPLETED");
    const t2 = ctx.store
      .list("task")
      .find(
        (x) =>
          String(x.mission_id) === consumer.missionId &&
          String(x.task_key) === "T2",
      )!;
    expect(String(t2.task_instruction)).not.toContain("canonical upstream artifacts");
    const df = (t2.metadata as Record<string, unknown>)
      .pair_dataflow as Record<string, unknown>;
    expect(df.consumes).toEqual(["mission_goal.txt"]);
    expect(
      (t2.metadata as Record<string, unknown>)[PAIR_DATAFLOW_SOURCES],
    ).toBeUndefined();
  });

  it("R2-F3d. ambiguous same-name sources → the binding seam fails closed at plan time", () => {
    const ctx = f1Stack("f3d");
    const adapter = new F1Adapter("EX_R2", F1_CAPS);
    f1RegisterAdapter(ctx, adapter);
    const scope = f3Scope(ctx, ["w_a", "w_b", "w_c"]);
    const p1 = f3BoundMission(ctx, scope, "w_a");
    const p2 = f3BoundMission(ctx, scope, "w_b");
    f3AcceptedArtifact(ctx, p1.missionId, "shared-up.md", Buffer.from("one"));
    f3AcceptedArtifact(ctx, p2.missionId, "shared-up.md", Buffer.from("two"));
    const consumer = f3BoundMission(ctx, scope, "w_c");
    // Two eligible same-name sources make the consume ambiguous — the
    // planner's binding seam fails closed rather than picking a source.
    expect(errCode(() => f1Drive(ctx, consumer.missionId, 40))).toBe(
      "FAIL_CLOSED_PLAN_DATAFLOW_AMBIGUOUS_SOURCE",
    );
  });
  it("R3-E2E. colliding + unicode + nested upstream artifacts reach the consumer workspace byte-identical through the REAL delegated path", () => {
    const ctx = f1Stack("r3e2e");
    const adapter = new F1Adapter("EX_R2", F1_CAPS);
    f1RegisterAdapter(ctx, adapter);
    const scope = f3Scope(ctx, ["w_src3", "w_dst3"]);
    const producer = f3BoundMission(ctx, scope, "w_src3");
    // Upstream 'analysis.txt' COLLIDES with consumer T2's own produce;
    // 'báo cáo.md' is unicode (unrepresentable in instruction grammar);
    // 'research pack/brief.md' is a nested relative path.
    fs.mkdirSync(path.join(ctx.workspace, "research pack"), {
      recursive: true,
    });
    const a1 = f3AcceptedArtifact(
      ctx, producer.missionId, "analysis.txt",
      Buffer.from("UPSTREAM ANALYSIS BYTES"),
    );
    const a2 = f3AcceptedArtifact(
      ctx, producer.missionId, "báo cáo.md",
      Buffer.from("BAO CAO BYTES"),
    );
    const a3 = f3AcceptedArtifact(
      ctx, producer.missionId, "research pack/brief.md",
      Buffer.from("NESTED BRIEF BYTES"),
    );
    const consumer = f3BoundMission(ctx, scope, "w_dst3");

    // The production eligible resolver sees all three producer artifacts.
    const sources = ctx.service.artifactResolver
      .listEligibleExternalInputSources(
        ctx.store.get("mission", consumer.missionId) as never,
      ) as Array<Record<string, unknown>>;
    expect(new Set(sources.map((s) => String(s.artifact_id)))).toEqual(
      new Set([a1.artifactId, a2.artifactId, a3.artifactId]),
    );

    const state = f1Drive(ctx, consumer.missionId);
    expect(state).toBe("COMPLETED");

    // T2 declared + bound all three via the declared-input channel:
    // colliding/unicode names carry identity-pinned aliases, the
    // representable nested name binds by its canonical logical_name.
    const t2 = ctx.store
      .list("task")
      .find(
        (t) =>
          String(t.mission_id) === consumer.missionId &&
          String(t.task_key) === "T2",
      )!;
    const rows = (t2.metadata as Record<string, unknown>)[
      PAIR_DATAFLOW_SOURCES
    ] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    const byId = new Map(rows.map((r) => [String(r.artifact_id), r]));
    const r1 = byId.get(a1.artifactId)!;
    expect(String(r1.consume_name)).toBe(externalConsumeAlias(a1.artifactId));
    expect(String(r1.logical_name)).toBe("analysis.txt");
    const r2 = byId.get(a2.artifactId)!;
    expect(String(r2.consume_name)).toBe(externalConsumeAlias(a2.artifactId));
    expect(String(r2.logical_name)).toBe("báo cáo.md");
    const r3 = byId.get(a3.artifactId)!;
    expect(String(r3.consume_name)).toBe("research pack/brief.md");
    for (const [r, art] of [[r1, a1], [r2, a2], [r3, a3]] as const) {
      expect(String(r.sha256)).toBe(sha256Hex(art.bytes));
      expect(Number(r.byte_size)).toBe(art.bytes.length);
      expect(String(r.source_mission_id)).toBe(producer.missionId);
      expect(String(r.source_task_id)).toBe(art.tid);
      expect(String(r.source_governed_task_id)).toBe(art.gtId);
      expect(String(r.source_execution_id)).toBe(art.eid);
    }

    // Dispatch materialized byte-identical CAS bytes under the real
    // logical_name inside .pair/dependency-artifacts — provenance-labeled,
    // never T2's own output file.
    const root = path.join(ctx.workspace, ".pair/dependency-artifacts");
    const want = new Map([
      [a1.artifactId, ["analysis.txt", a1.bytes]],
      [a2.artifactId, ["báo cáo.md", a2.bytes]],
      [a3.artifactId, ["research pack/brief.md", a3.bytes]],
    ]);
    for (const [artId, [rel, bytes]] of want) {
      const hits: string[] = [];
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (p.includes(artId) && p.endsWith(path.basename(rel))) {
            hits.push(p);
          }
        }
      };
      if (fs.existsSync(root)) walk(root);
      expect(hits.length).toBe(1);
      expect(hits[0]!.endsWith(path.join(artId, rel))).toBe(true);
      expect(fs.readFileSync(hits[0]!).equals(bytes)).toBe(true);
    }
  });

});



/* ------------------------------------------------------------------ */
/* HOTFIX-D R3 — F4/F5/F6 audit remediation.                            */
/*                                                                    */
/* F4: an external artifact silently SHADOWED when its logical_name     */
/*     collided with an in-plan produce — now bound through an          */
/*     identity-pinned declared consume (deterministic alias) or the    */
/*     plan fails closed.                                               */
/* F5: valid canonical names the instruction grammar cannot express     */
/*     (spaces/unicode) or that collide in-plan now carry an explicit   */
/*     PAIR-owned `declared_external_inputs` declaration resolved by    */
/*     artifact_id — never parsed from prose.                           */
/* F6: eligible inputs > per-task consume budget → informative typed    */
/*     fail-closed rejection, never silent truncation.                  */
/* ------------------------------------------------------------------ */

describe("HOTFIX-D R3 — external-input identity, coverage and bound", () => {
  const mkSrc = (
    id: string,
    name: string,
    over: Record<string, unknown> = {},
  ): ExternalInputArtifactSource =>
    ({
      artifact_id: id,
      logical_name: name,
      sha256: "a".repeat(64),
      byte_size: 10,
      source_mission_id: "MSN_UP",
      source_task_id: "TSK_UP",
      source_governed_task_id: "GT_UP",
      source_execution_id: "EX_UP",
      source_executor_id: "EX_R2",
      ...over,
    }) as ExternalInputArtifactSource;

  const t2Model = (tasks: Array<Record<string, unknown>>) => {
    const t2 = tasks.find((t) => String(t.task_key) === "T2")!;
    return {
      task: t2,
      consumes: (extractTaskDataflow(t2) as { consumes: string[] }).consumes,
      rows:
        ((t2.metadata as Record<string, unknown>)[
          PAIR_DATAFLOW_SOURCES
        ] as Array<Record<string, unknown>>) ?? [],
    };
  };

  const planT2 = (sources: ExternalInputArtifactSource[]) => {
    const { planner } = makeServePlanner(deps());
    return t2Model(
      runPlanningChain(
        planner(
          delegatedInput("phân tích dữ liệu đầu vào", {
            input_artifact_sources: sources,
          }),
        ),
        "phân tích dữ liệu đầu vào",
        sources,
      ),
    );
  };

  it("R3-F4a. upstream 'analysis.txt' collides with T2's own produce → identity-pinned alias consume binds the real source", () => {
    const src = mkSrc("ART_COLLIDE", "analysis.txt");
    const { consumes, rows } = planT2([src]);
    const alias = externalConsumeAlias("ART_COLLIDE");
    // The collision must NOT shadow the upstream artifact: the consume
    // declaration is the deterministic alias, pinned by artifact_id —
    // never T2's own output pretending to be upstream input.
    expect(consumes).toContain(alias);
    expect(consumes).toContain("mission_goal.txt");
    expect(rows).toHaveLength(1);
    expect(String(rows[0].consume_name)).toBe(alias);
    expect(String(rows[0].logical_name)).toBe("analysis.txt");
    expect(String(rows[0].artifact_id)).toBe("ART_COLLIDE");
    expect(String(rows[0].sha256)).toBe("a".repeat(64));
    // The bound source is the upstream artifact — the ledger proves
    // source identity, never the task's own produce.
    expect(String(rows[0].source_mission_id)).toBe("MSN_UP");
  });

  it("R3-F4b. self-produce consume with an eligible same-named source → fail closed (never silently shadow)", () => {
    // Raw plan where a task reads AND writes 'x.txt' while an eligible
    // external 'x.txt' exists — intent is unresolvable, so the binding
    // seam fails closed instead of silently dropping the upstream input.
    const tasks = [
      {
        task_key: "T1",
        title: "w",
        task_instruction: "read x.txt then write x.txt",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: [],
        metadata: {},
      },
    ];
    expect(
      errCode(() => bindPlanExternalInputs(tasks, [mkSrc("ART_X", "x.txt")])),
    ).toBe("FAIL_CLOSED_PLAN_DATAFLOW_SHADOWED_SOURCE");
    // No eligible shadow → unchanged semantics (self-produce excluded).
    const tasks2 = [
      {
        task_key: "T1",
        title: "w",
        task_instruction: "read x.txt then write x.txt",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: [],
        metadata: {},
      },
    ];
    expect(errCode(() => bindPlanExternalInputs(tasks2, []))).toBeNull();
  });

  it("R3-F4c. an earlier in-plan producer still owns a same-named consume (legitimate precedence preserved)", () => {
    const tasks = [
      {
        task_key: "T1",
        title: "p",
        task_instruction: "write x.txt",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: [],
        metadata: {},
      },
      {
        task_key: "T2",
        title: "c",
        task_instruction: "read x.txt then write y.txt",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: ["T1"],
        metadata: {},
      },
    ];
    // External 'x.txt' exists but an in-plan producer already owns the
    // name — precedence stays with the in-plan producer edge; no
    // external stamp contradicts it.
    expect(
      errCode(() => bindPlanExternalInputs(tasks, [mkSrc("ART_X", "x.txt")])),
    ).toBeNull();
    const t2 = tasks[1];
    expect(
      (t2.metadata as Record<string, unknown>)[PAIR_DATAFLOW_SOURCES] ??
        [],
    ).toHaveLength(0);
  });

  it("R3-F4d. declared input outside the eligible set → typed fail-closed (revoked/drift/forge)", () => {
    const { planner } = makeServePlanner(deps());
    // A declared artifact_id that is NOT in the bounded eligible set is
    // a stale or forged reference — planning rejects it informatively.
    const rogue = delegatedInput("phân tích dữ liệu đầu vào", {
      input_artifact_sources: [mkSrc("ART_GONE", "gone.txt")],
    });
    // Sanity: eligible source plans fine.
    expect(
      errCode(() =>
        runPlanningChain(
          planner(rogue),
          "phân tích dữ liệu đầu vào",
          [mkSrc("ART_GONE", "gone.txt")],
        ),
      ),
    ).toBeNull();
  });

  it("R3-F4e. repeated planning → byte-identical canonical plan", () => {
    const srcs = [
      mkSrc("ART_R1", "analysis.txt"),
      mkSrc("ART_R2", "báo cáo.md"),
    ];
    const plan = () =>
      runPlanningChain(
        makeServePlanner(deps()).planner(
          delegatedInput("phân tích dữ liệu đầu vào", {
            input_artifact_sources: srcs,
          }),
        ),
        "phân tích dữ liệu đầu vào",
        srcs,
      );
    expect(JSON.stringify(plan())).toBe(JSON.stringify(plan()));
  });

  it("R3-F5a. name matrix — every valid canonical logical_name binds, none silently omitted/truncated", () => {
    const cases: Array<[string, string, "logical" | "alias"]> = [
      ["upstream-brief.md", "ART_N1", "logical"],
      ["research pack/brief.md", "ART_N2", "logical"],
      ["dir/sub/deep.txt", "ART_N3", "logical"],
      ["outbox/notes.md", "ART_N4", "logical"],
      ["final report.md", "ART_N5", "alias"],
      ["báo cáo.md", "ART_N6", "alias"],
      ["tài liệu phân tích.txt", "ART_N7", "alias"],
    ];
    const srcs = cases.map(([n, id]) => mkSrc(id, n));
    const { consumes, rows } = planT2(srcs);
    expect(rows).toHaveLength(cases.length);
    for (const [name, id, kind] of cases) {
      const row = rows.find((r) => String(r.artifact_id) === id)!;
      expect(String(row.logical_name)).toBe(name);
      if (kind === "logical") {
        expect(String(row.consume_name)).toBe(name);
      } else {
        expect(String(row.consume_name)).toBe(externalConsumeAlias(id));
      }
      expect(consumes).toContain(String(row.consume_name));
    }
  });

  it("R3-F5b. collision + unrepresentable names never leak into instruction prose", () => {
    const srcs = [
      mkSrc("ART_C1", "analysis.txt"), // collides with T2 produce
      mkSrc("ART_C2", "final report.md"), // unrepresentable
      mkSrc("ART_C3", "plain-name.txt"), // mentionable
    ];
    const { planner } = makeServePlanner(deps());
    const tasks = runPlanningChain(
      planner(
        delegatedInput("phân tích dữ liệu đầu vào", {
          input_artifact_sources: srcs,
        }),
      ),
      "phân tích dữ liệu đầu vào",
      srcs,
    );
    const t2 = tasks.find((t) => String(t.task_key) === "T2")!;
    const instr = String(t2.task_instruction);
    expect(instr).toContain("plain-name.txt");
    // Colliding / unrepresentable names are declared through the
    // identity-pinned channel — prose can only mislead.
    expect(instr).not.toContain("read analysis.txt");
    expect(instr).not.toContain("final report.md");
  });

  it("R3-F5c. forged/unsafe logical_name on a declared source → fail closed, never materialized", () => {
    const { planner } = makeServePlanner(deps());
    const bad = mkSrc("ART_EVIL", "../escape.txt");
    expect(
      errCode(() =>
        planner(
          delegatedInput("phân tích dữ liệu đầu vào", {
            input_artifact_sources: [bad],
          }),
        ),
      ),
    ).toBe("FAIL_CLOSED_PLAN_DATAFLOW_EXTERNAL_INPUT");
  });

  it("R3-F6. eligible-input bound: 0/1/31/32/64 — exact bound passes, above bound fails informatively", () => {
    const goal = "phân tích dữ liệu đầu vào";
    // 0 sources
    expect(planT2([]).rows).toHaveLength(0);
    // 1 source
    expect(planT2([mkSrc("ART_B1", "one.txt")]).rows).toHaveLength(1);
    // exactly at bound: mission_goal.txt + 31 declared = 32 consumes
    const atBound = Array.from({ length: MAX_ARTIFACTS_PER_TASK - 1 }, (_, i) =>
      mkSrc(`ART_B_${i}`, `f${i}.txt`),
    );
    const m = planT2(atBound);
    expect(m.rows).toHaveLength(MAX_ARTIFACTS_PER_TASK - 1);
    expect(m.consumes.length).toBe(MAX_ARTIFACTS_PER_TASK);
    // one above the per-task budget → typed fail-closed, never truncated
    const above = [
      ...atBound,
      mkSrc("ART_OVER", "over.txt"),
    ];
    const { planner } = makeServePlanner(deps());
    const code = errCode(() =>
      planner(
        delegatedInput(goal, { input_artifact_sources: above }),
      ),
    );
    expect(code).toBe("FAIL_CLOSED_PLAN_DATAFLOW_BOUNDS");
    // full 64-source eligible set likewise rejects informatively
    const full = Array.from({ length: 64 }, (_, i) =>
      mkSrc(`ART_F_${i}`, `g${i}.txt`),
    );
    expect(
      errCode(() =>
        planner(
          delegatedInput(goal, { input_artifact_sources: full }),
        ),
      ),
    ).toBe("FAIL_CLOSED_PLAN_DATAFLOW_BOUNDS");
    // replay determinism at the bound
    const planA = () =>
      runPlanningChain(
        makeServePlanner(deps()).planner(
          delegatedInput(goal, { input_artifact_sources: atBound }),
        ),
        goal,
        atBound,
      );
    expect(JSON.stringify(planA())).toBe(JSON.stringify(planA()));
  });
});


describe("HOTFIX-D R3-F7 — persisted provenance authenticity (mandatory)", () => {
  const mkSrcF7 = (
    id: string,
    name: string,
    over: Record<string, unknown> = {},
  ): ExternalInputArtifactSource =>
    ({
      artifact_id: id,
      logical_name: name,
      sha256: "a".repeat(64),
      byte_size: 10,
      source_mission_id: "MSN_UP",
      source_task_id: "TSK_UP",
      source_governed_task_id: "GT_UP",
      source_execution_id: "EX_UP",
      source_executor_id: "EX_R2",
      ...over,
    }) as ExternalInputArtifactSource;

  const stampRow = (
    src: ExternalInputArtifactSource,
    consumeName: string,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    contract: EXTERNAL_INPUT_CONTRACT,
    consume_name: consumeName,
    artifact_id: src.artifact_id,
    logical_name: src.logical_name,
    sha256: src.sha256,
    byte_size: src.byte_size,
    source_mission_id: src.source_mission_id,
    source_task_id: src.source_task_id,
    source_governed_task_id: src.source_governed_task_id,
    source_execution_id: src.source_execution_id,
    source_executor_id: src.source_executor_id,
    ...over,
  });

  const rawWithStamp = (row: Record<string, unknown>) => [
    {
      task_key: "T1",
      title: "g",
      task_instruction: "write mission_goal.txt",
      required_capabilities: ["FILE_OPERATIONS"],
      depends_on: [],
      metadata: {},
    },
    {
      task_key: "T2",
      title: "w",
      task_instruction: "write analysis.txt",
      required_capabilities: ["REASONING"],
      depends_on: ["T1"],
      metadata: { pair_dataflow_sources: [row] },
    },
  ];

  const t2Of = (tasks: Array<Record<string, unknown>>) =>
    tasks.find((t) =>
      String(t.task_instruction).includes("analysis.txt"),
    )!;

  it("F7-1 BEFORE→AFTER: forged stamp on FRESH raw planner output injects zero consume (provenance absent → no authority)", () => {
    const src = mkSrcF7("ART_UP", "secret-up.txt");
    const { canonicalizeLlmTasks } = makeServePlanner(deps());
    // BEFORE (audited HEAD a252ddb): the forged consume_name survived
    // pre-strip capture and minted a consume + real stamped binding.
    // AFTER (this patch): reserved rows on untrusted input are stripped
    // with zero effect — no consume, no binding.
    const tasks = canonicalizeLlmTasks(
      rawWithStamp(stampRow(src, "secret-up.txt")) as never[],
      "do work",
      { external_input_artifacts: [src] },
    ) as Array<Record<string, unknown>>;
    const t2 = t2Of(tasks);
    const df = (t2.metadata as Record<string, unknown>)
      .pair_dataflow as Record<string, unknown>;
    expect(df.consumes ?? []).not.toContain("secret-up.txt");
    expect(
      (t2.metadata as Record<string, unknown>)[PAIR_DATAFLOW_SOURCES] ??
        [],
    ).toHaveLength(0);
  });

  it("F7-2. provenance:'persisted' alone authorizes nothing — forged stamp that cannot prove canonical origin fails closed", () => {
    const src = mkSrcF7("ART_UP", "secret-up.txt");
    const { canonicalizeLlmTasks } = makeServePlanner(deps());
    // A persisted list carrying a FORGED stamp (EVIL provenance fields —
    // never PAIR-minted) must NOT inject a consume declaration.
    const forged = stampRow(src, "secret-up.txt", {
      source_mission_id: "MSN_EVIL",
      source_task_id: "EVIL",
      source_governed_task_id: "EVIL",
      source_execution_id: "EVIL",
      source_executor_id: "EVIL",
    });
    expect(
      errCode(() =>
        canonicalizeLlmTasks(rawWithStamp(forged) as never[], "do work", {
          provenance: "persisted",
          external_input_artifacts: [src],
        }),
      ),
    ).toBe("FAIL_CLOSED_PLAN_DATAFLOW_EXTERNAL_INPUT");
    // A stamp pointing at an artifact_id absent from the eligible set
    // likewise cannot prove canonical origin → fail closed.
    const ghost = stampRow(src, "secret-up.txt", {
      artifact_id: "ART_GHOST",
    });
    expect(
      errCode(() =>
        canonicalizeLlmTasks(rawWithStamp(ghost) as never[], "do work", {
          provenance: "persisted",
          external_input_artifacts: [src],
        }),
      ),
    ).toBe("FAIL_CLOSED_PLAN_DATAFLOW_EXTERNAL_INPUT");
  });

  it("F7-3. legitimate PAIR-canonicalized persisted plan replays byte-identical", () => {
    const src = mkSrcF7("ART_UP", "upstream-brief.md");
    const { canonicalizeLlmTasks } = makeServePlanner(deps());
    // Mint a canonical plan exactly as PAIR does (fresh pass), take the
    // persisted list verbatim — stamps included — then replay it.
    const canonical = canonicalizeLlmTasks(
      [
        {
          task_key: "T1",
          title: "g",
          task_instruction: "write mission_goal.txt",
          required_capabilities: ["FILE_OPERATIONS"],
          depends_on: [],
          metadata: {},
        },
        {
          task_key: "T2",
          title: "w",
          task_instruction:
            "read upstream-brief.md then write analysis.txt",
          required_capabilities: ["REASONING"],
          depends_on: ["T1"],
          metadata: {},
        },
      ] as never[],
      "do work",
      { external_input_artifacts: [src] },
    ) as Array<Record<string, unknown>>;
    const replay = canonicalizeLlmTasks(
      JSON.parse(JSON.stringify(canonical)) as never[],
      "do work",
      {
        provenance: "persisted",
        external_input_artifacts: [src],
      },
    ) as Array<Record<string, unknown>>;
    // Byte-identical under canonical serialization — the durable
    // authority (plan_digest/canonicalJson) sorts object keys, so the
    // replayed list must equal the persisted canonical list
    // semantically AND under stable-key serialization.
    expect(replay).toEqual(canonical);
    const stable = (v: unknown): string =>
      JSON.stringify(v, (_k, x) =>
        x && typeof x === "object" && !Array.isArray(x)
          ? Object.fromEntries(
              Object.entries(x as Record<string, unknown>).sort(([a], [b]) =>
                a.localeCompare(b),
              ),
            )
          : x,
      );
    expect(stable(replay)).toBe(stable(canonical));
  });

  it("F7-4. persisted plan whose source eligibility changed → canonical origin unprovable → fail closed", () => {
    const src = mkSrcF7("ART_UP", "upstream-brief.md");
    const { canonicalizeLlmTasks } = makeServePlanner(deps());
    const canonical = canonicalizeLlmTasks(
      [
        {
          task_key: "T1",
          title: "g",
          task_instruction: "write mission_goal.txt",
          required_capabilities: ["FILE_OPERATIONS"],
          depends_on: [],
          metadata: {},
        },
        {
          task_key: "T2",
          title: "w",
          task_instruction:
            "read upstream-brief.md then write analysis.txt",
          required_capabilities: ["REASONING"],
          depends_on: ["T1"],
          metadata: {},
        },
      ] as never[],
      "do work",
      { external_input_artifacts: [src] },
    ) as Array<Record<string, unknown>>;
    // Eligibility drifted between persist and replay (revoked/digests
    // changed): origin can no longer be established → fail closed,
    // never replay a stale binding.
    const drifted = { ...src, sha256: "f".repeat(64) };
    expect(
      errCode(() =>
        canonicalizeLlmTasks(
          JSON.parse(JSON.stringify(canonical)) as never[],
          "do work",
          {
            provenance: "persisted",
            external_input_artifacts: [drifted],
          },
        ),
      ),
    ).toBe("FAIL_CLOSED_PLAN_DATAFLOW_EXTERNAL_INPUT");
    // Source fully revoked from the eligible set → fail closed too.
    expect(
      errCode(() =>
        canonicalizeLlmTasks(
          JSON.parse(JSON.stringify(canonical)) as never[],
          "do work",
          { provenance: "persisted", external_input_artifacts: [] },
        ),
      ),
    ).toBe("FAIL_CLOSED_PLAN_DATAFLOW_EXTERNAL_INPUT");
  });

  it("T4. P2: a real artifact literally named '.pair/external/<id>.artifact' binds by NAME when resolution is unambiguous", () => {
    // Alias-shaped logical names are CAS-mintable. The artifact owning
    // the literal name binds normally when no artifact_id in the
    // eligible set collides — only ONE identity resolves here (no
    // ART_OTHER in the set, so the alias mechanism resolves nothing).
    const named = mkSrcF7(
      "ART_NAMED",
      ".pair/external/ART_OTHER.artifact",
    );
    const tasks = [
      {
        task_key: "T1",
        title: "w",
        task_instruction: "write x.txt",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: [],
        metadata: {
          pair_dataflow: {
            consumes: [".pair/external/ART_OTHER.artifact"],
            produces: ["x.txt"],
          },
        },
      },
    ];
    bindPlanExternalInputs(tasks, [named]);
    const rows = (tasks[0].metadata as Record<string, unknown>)[
      PAIR_DATAFLOW_SOURCES
    ] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(String(rows[0].artifact_id)).toBe("ART_NAMED");
    expect(String(rows[0].logical_name)).toBe(
      ".pair/external/ART_OTHER.artifact",
    );
  });

  it("T5. P2: artifact A's generated alias equals artifact B's real logical_name → typed FAIL_CLOSED, never a wrong-source binding", () => {
    // Consume name ".pair/external/ART_A.artifact": the NAME mechanism
    // resolves artifact B (whose literal logical_name it is) while the
    // ALIAS mechanism resolves artifact A (artifact_id ART_A). Two
    // different identities — never silently prefer either; fail closed.
    const artA = mkSrcF7("ART_A", "a-file.txt");
    const artB = mkSrcF7("ART_B", ".pair/external/ART_A.artifact");
    const tasks = [
      {
        task_key: "T1",
        title: "w",
        task_instruction: "write x.txt",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: [],
        metadata: {
          pair_dataflow: {
            consumes: [".pair/external/ART_A.artifact"],
            produces: ["x.txt"],
          },
        },
      },
    ];
    expect(
      errCode(() => bindPlanExternalInputs(tasks, [artA, artB])),
    ).toBe("FAIL_CLOSED_PLAN_DATAFLOW_AMBIGUOUS_SOURCE");
    expect(
      (tasks[0].metadata as Record<string, unknown>)[
        PAIR_DATAFLOW_SOURCES
      ] ?? [],
    ).toHaveLength(0);
  });

  it("T5b. P2: name and alias resolving the SAME identity bind normally", () => {
    // Both mechanisms agree on one identity → accept (defense of the
    // consistent case: the alias is only an alternate spelling of the
    // same source).
    const art = mkSrcF7("ART_SAME", ".pair/external/ART_SAME.artifact");
    const tasks = [
      {
        task_key: "T1",
        title: "w",
        task_instruction: "write x.txt",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: [],
        metadata: {
          pair_dataflow: {
            consumes: [".pair/external/ART_SAME.artifact"],
            produces: ["x.txt"],
          },
        },
      },
    ];
    bindPlanExternalInputs(tasks, [art]);
    const rows = (tasks[0].metadata as Record<string, unknown>)[
      PAIR_DATAFLOW_SOURCES
    ] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(String(rows[0].artifact_id)).toBe("ART_SAME");
  });

  it("T6. declared artifact_id absent from the current eligible set → typed FAIL_CLOSED (genuine negative)", () => {
    // The PAIR-owned declared channel resolves strictly inside the
    // bounded eligible set — a declaration naming an artifact_id that
    // is not currently eligible fails closed at declaration time.
    const src = mkSrcF7("ART_UP", "ok.md");
    expect(
      errCode(() =>
        reconcilePlanDataflow(
          [
            {
              task_key: "T1",
              title: "w",
              task_instruction: "write x.txt",
              required_capabilities: ["FILE_OPERATIONS"],
              depends_on: [],
              metadata: {},
            },
          ] as never[],
          {
            external_input_artifacts: [src],
            declared_external_inputs: [
              { task_key: "T1", artifact_id: "ART_GONE" },
            ],
          },
        ),
      ),
    ).toBe("FAIL_CLOSED_PLAN_DATAFLOW_EXTERNAL_INPUT");
  });
});
