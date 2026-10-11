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
  assertPlanDataflow,
  assertTaskDeliverySemantic,
  bindPlanExternalInputs,
  canonicalBookkeepingTask,
  detectOutputLanguage,
  detectTelegramDeliveryIntent,
  digest,
  ExecutorRegistry,
  EXTERNAL_INPUT_CONTRACT,
  GovernedTaskGate,
  injectDeliveryTaskForTrueOmission,
  isDeliveryTask,
  makeServePlanner,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionSupervisor,
  PAIR_DATAFLOW_SOURCES,
  PAIR_DELIVERY_INJECTION_KEY,
  PAIR_OUTPUT_LANGUAGE_KEY,
  PAIR_PLAN_CONTRACT_KEY,
  PairControlPlane,
  PairEvidenceStore,
  pendingTelegramDeliveries,
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
  validatePlanProposal,
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
        {
          task_key: "T2",
          title: "deliver the report",
          task_instruction:
            "compose the summary and write outbox/report.txt, then reply DONE.",
          required_capabilities: ["TELEGRAM_DELIVERY"],
          depends_on: ["T1"],
          metadata: {
            [PAIR_DELIVERY_INJECTION_KEY]: {
              reason: "DELIVERY_TASK_INJECTED",
              task_key: "T2",
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
