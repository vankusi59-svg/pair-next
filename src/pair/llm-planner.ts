/**
 * llm-planner.ts — PAIR OS vNext LLM plan proposer (P-UI-6 spec).
 *
 * Proposal-only: turns a natural-language goal into a governed task DAG by
 * asking an LLM (OpenAI-compatible chat/completions endpoint). Output is
 * untrusted: JSON-parsed, schema-checked, capability-whitelisted, size-capped;
 * malformed or violating output degrades to a deterministic fallback plan.
 * Never mutates canonical state, never picks executors — only proposes
 * `required_capabilities`; routing stays with CapabilityRouter.
 */

import { PolicyError } from "./errors.js";
import { extractTaskDataflow } from "./plan-dataflow.js";

export const LLM_PLANNER_MAX_INSTRUCTION = 2000;
export const LLM_PLANNER_DEFAULT_MAX_TASKS = 5;
export const LLM_PLANNER_DEFAULT_TIMEOUT_MS = 20000;
/** A usable plan always has >=2 tasks: T1 only records the goal. */
export const LLM_PLANNER_MIN_TASKS = 2;

export interface LlmPlannerConfig {
  /** Provider chat/completions URL (P6 endpoint_reference). */
  endpoint: string;
  /** Env var NAME holding the API key — never the value itself. */
  credentialEnv: string;
  model: string;
  maxTasks?: number;
  /** Whitelist of capabilities the LLM may request (non-empty per task). */
  allowedCapabilities: string[];
  /** Each entry = one executor's capability list; a task whose caps are not
   *  jointly servable by a single entry is dropped (DROP_UNSERVABLE_CAPS). */
  capabilitySets?: string[][];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv | ((name: string) => string | undefined);
  /** Injectable for tests — defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** F3 — bounded structured failure context on a REPLAN: the planner must
   *  propose a feasible ALTERNATIVE, never a semantic re-emission of the
   *  failed plan; the rejected digests are named in the prompt. */
  replanContext?: {
    recovery_id?: string;
    failure_signature?: string | null;
    failure_class: string;
    dependency_reason?: string | null;
    failed_task_key?: string | null;
    failed_plan_semantic_digest?: string | null;
    rejected_semantic_digests?: string[];
  };
}

export interface LlmPlanResult {
  tasks: Array<Record<string, unknown>>;
  source: "LLM" | "FALLBACK";
  model?: string;
  warnings: string[];
}

type RawTask = {
  task_key?: unknown;
  title?: unknown;
  task_instruction?: unknown;
  required_capabilities?: unknown;
  depends_on?: unknown;
  metadata?: unknown;
};

/** Minimal safe plan — same PAIR_NATIVE contract as the template planner. */
export function fallbackTasks(goal: string): Array<Record<string, unknown>> {
  return [
    {
      task_key: "T1",
      title: "record mission goal",
      task_instruction: goal,
      required_capabilities: ["AUTOMATON_TASK_EXECUTION"],
      depends_on: [],
      metadata: {
        expected_output_contract: {
          type: "TASK_RESULT",
          worker_spec: {
            ops: [
              { op: "write_text_file", path: "mission_goal.txt", content: goal, idempotency_class: "WRITE", risk_class: "MEDIUM" },
              { op: "finish", result: { summary: "goal recorded" }, idempotency_class: "READ_ONLY", risk_class: "LOW" },
            ],
            limits: { max_ops: 4, timeout_seconds: 30 },
            allowed_ops: ["write_text_file", "finish"],
          },
        },
      },
    },
  ];
}

function envGet(env: LlmPlannerConfig["env"], name: string): string | undefined {
  if (!env) return process.env[name];
  return typeof env === "function" ? env(name) : env[name];
}

/** Extract the first balanced {...} JSON object from LLM text output. */
function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/g, "").trim();
  const start = stripped.indexOf("{");
  if (start < 0) throw new PolicyError("LLM_PLAN_NO_JSON", "planner.parse");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(stripped.slice(start, i + 1));
    }
  }
  throw new PolicyError("LLM_PLAN_UNBALANCED_JSON", "planner.parse");
}

/**
 * Capabilities served by remote executors whose outputs live on the remote
 * side (returned as refs, not local workspace files). F2: a downstream task
 * may consume a remote artifact ONLY through an explicitly declared
 * produces/consumes edge — undeclared remote coupling stays rejected.
 */
const REMOTE_CAPS = new Set([
  "REMOTE_CLOUD_TASK_EXECUTION",
  "AUTONOMOUS_CODE_EXECUTION",
]);

/**
 * Validate + clamp raw LLM tasks into a safe proposal. Rules (spec §2.1):
 * task_key T\d+ unique; depends_on only references earlier keys (acyclic);
 * required_capabilities ⊆ whitelist, non-empty; instruction ≤ cap;
 * count ≤ maxTasks; invalid tasks dropped (later deps re-pointed or dropped).
 * + every task's capability set must be jointly servable by ≥1 executor
 * (capabilitySets param, each entry = one executor's capability list); and
 * remote-capability tasks must be leaves — no later task may depend on them.
 */
export function sanitizePlan(
  raw: RawTask[],
  allowedCapabilities: string[],
  maxTasks: number,
  capabilitySets?: string[][],
): { tasks: Array<Record<string, unknown>>; warnings: string[] } {
  const capSet = new Set(allowedCapabilities);
  const warnings: string[] = [];
  const tasks: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const remoteKeys = new Set<string>();
  const rawByKey = new Map(raw.map((t) => [String(t.task_key ?? ""), t]));
  /** F2 §20 — sanitize-stage edge check via the same dataflow model the
   *  committed plan applies later (planner-supplied pair_dataflow is a
   *  hint only; assertPlanDataflow re-verifies without reserved keys). */
  const candidateTaskDataflow = (t: Record<string, unknown>) => {
    try {
      return extractTaskDataflow(t);
    } catch {
      return { produces: [] as string[], consumes: [] as string[] };
    }
  };
  for (const t of raw) {
    if (tasks.length >= maxTasks) {
      warnings.push("MAX_TASKS_TRUNCATED");
      break;
    }
    const key = String(t.task_key ?? "");
    if (!/^T\d+$/.test(key) || seen.has(key)) {
      warnings.push(`DROP_INVALID_TASK_KEY:${key || "?"}`);
      continue;
    }
    const caps = Array.isArray(t.required_capabilities)
      ? t.required_capabilities.map((c) => String(c)).filter((c) => capSet.has(c))
      : [];
    if (!caps.length) {
      warnings.push(`DROP_NO_ALLOWED_CAPS:${key}`);
      continue;
    }
    // The capability set must be jointly servable by a single executor —
    // routing picks one executor per task; an unservable combo is dead work.
    if (
      capabilitySets?.length &&
      !capabilitySets.some((set) => caps.every((c) => set.includes(c)))
    ) {
      warnings.push(`DROP_UNSERVABLE_CAPS:${key}`);
      continue;
    }
    const instruction = String(t.task_instruction ?? "").slice(0, LLM_PLANNER_MAX_INSTRUCTION);
    if (!instruction.trim()) {
      warnings.push(`DROP_EMPTY_INSTRUCTION:${key}`);
      continue;
    }
    // F2 §20 — remote tasks are no longer unconditional leaves: a
    // dependent may consume remote output ONLY through an explicitly
    // declared artifact edge (a consume name the remote dep produces).
    // TELEGRAM_DELIVERY remains exempt (it consumes result text via
    // dependency_outputs, not remote files). A remote dep with no
    // declared edge stays rejected — plan-dataflow re-verifies the same
    // rule authoritatively against the committed plan.
    const isTelegramDelivery = caps.includes("TELEGRAM_DELIVERY");
    const deps = Array.isArray(t.depends_on)
      ? [...new Set(t.depends_on.map((d) => String(d)).filter((d) => seen.has(d)))]
      : [];
    if (!isTelegramDelivery) {
      const cand = candidateTaskDataflow({
        task_key: key,
        task_instruction: instruction,
        required_capabilities: caps,
        metadata:
          t.metadata &&
          typeof t.metadata === "object" &&
          !Array.isArray(t.metadata)
            ? t.metadata
            : {},
      });
      const ungoverned = deps.some((d) => {
        if (!remoteKeys.has(d)) return false;
        const depProduces = candidateTaskDataflow(rawByKey.get(d) ?? {});
        return !cand.consumes.some((c) => depProduces.produces.includes(c));
      });
      if (ungoverned) {
        warnings.push(`DROP_REMOTE_DEPENDENT:${key}`);
        continue;
      }
    }
    if (Array.isArray(t.depends_on) && deps.length !== new Set(t.depends_on.map((d) => String(d))).size) {
      warnings.push(`DEP_FORWARD_OR_UNKNOWN_PRUNED:${key}`);
    }
    if (caps.some((c) => REMOTE_CAPS.has(c))) remoteKeys.add(key);
    seen.add(key);
    const metadata =
      t.metadata && typeof t.metadata === "object" && !Array.isArray(t.metadata)
        ? (t.metadata as Record<string, unknown>)
        : {};
    tasks.push({
      task_key: key,
      title: String(t.title ?? key).slice(0, 200),
      task_instruction: instruction,
      required_capabilities: caps.sort(),
      depends_on: deps,
      metadata,
    });
  }
  return { tasks, warnings };
}

const SYSTEM_PROMPT = `You are the PAIR OS mission planner. Convert the operator's mission goal into a JSON task DAG.

Output ONLY a JSON object: {"tasks": [...]}. Each task:
- "task_key": "T1", "T2", ... sequential
- "title": short label
- "task_instruction": self-contained instruction for an autonomous executor agent. It must name the REAL WORK the operator asked for — carry the goal's subject matter verbatim into the instruction (e.g. goal "phân tích giá vàng hôm nay" → instruction "analyze today's gold price using ICT concepts — market structure, liquidity, order blocks — and write findings to analysis.txt"). NEVER emit meta-instructions like "analyze the goal" or "summarize the mission". Mention workspace-relative file paths when files must be read/written (e.g. "read mission_goal.txt", "write result to out.txt"). The executor runs inside the mission workspace.
- "required_capabilities": subset of the ALLOWED_CAPABILITIES list — pick the minimum needed. The router maps capabilities to executors; you never name an executor.
- "depends_on": earlier task_keys only (DAG, acyclic). MUST list every task whose output this task needs: if it reads/copies/delivers a file another task writes, or uses its returned result, the producer goes in depends_on. Undeclared inputs make the task run before its data exists. Independent tasks stay parallel — only real producers are dependencies.

Rules:
- Always include a first task T1 that records the goal into mission_goal.txt via capability AUTOMATON_TASK_EXECUTION.
- 2 to MAX_TASKS tasks. Prefer analysis/reasoning steps (REASONING) for thinking work, CODE_GENERATION/PYTHON_EXECUTION for code, SHELL_EXECUTION for running things, FILE_OPERATIONS/AUTOMATON_TASK_EXECUTION for pure file writes.
- LIVE DATA: if the goal needs current/external information (words like "hôm nay", "hiện tại", "giá", "tin tức", "mới nhất", "today", "current", "latest", "news", "price") that local executors cannot fetch — local executors have NO internet — the data-gathering task MUST use REMOTE_CLOUD_TASK_EXECUTION (the remote executor has a real browser/network). Instruct it to RETURN the full findings as its final result text — files it writes stay remote and are invisible locally.
- REAL BUILD WORK: when the goal asks to actually BUILD or FIX software (xây/build/create a website/app/tool/bot/script, viết code, fix bug, deploy) — i.e. real code across multiple files, not a single small file — the build task MUST use REMOTE_CLOUD_TASK_EXECUTION. Local executors can only write simple text files and CANNOT code real software; giving them build work produces documentation instead of a product. Instruct the remote task to RETURN a summary + key file contents (or upload via outbox for larger artifacts).
- REMOTE_CLOUD_TASK_EXECUTION / AUTONOMOUS_CODE_EXECUTION run on a REMOTE executor: their result text comes back, and their uploaded files land as canonical artifacts. A downstream task may depend on a remote task ONLY when it explicitly declares the produced artifact as an input (read the file it produces — name the artifact in its instruction or worker_spec); a remote dep with no declared artifact edge is rejected. TELEGRAM_DELIVERY tasks always may depend on remote tasks (they receive the remote result text through dependency_outputs).
- VISUAL DELIVERABLES: if the goal asks for a real chart, screenshot, or image (chụp ảnh/biểu đồ/chart/screenshot), the remote task must capture it with its browser AND upload the file via the outbox endpoint described in its prompt — the file is unusable if it stays on the remote machine. Followed by a TELEGRAM_DELIVERY task when the goal also asks to send it to the operator.
- TELEGRAM_DELIVERY (when ALLOWED): ONLY when the goal EXPLICITLY asks to send/deliver named output to Telegram (gửi tele/telegram, báo qua telegram, send/deliver to telegram) — never add it for a goal that merely mentions a file, an outbox, or completion. Add it as a DAG-leaf task with capability TELEGRAM_DELIVERY, depending ONLY on the tasks that produce what the goal asked to be sent. PAIR pins the delivery manifest, the canonical output language, and the final delivery instruction from the operator request — the plan does not choose what may be sent, in which language, or how. Instruction placeholder: "Stage the manifested artifacts into outbox/ unchanged, then reply DONE." (PAIR rewrites it canonically.)
- FILE DELIVERABLES: when the goal names a file to create AND asks to send it (e.g. "tạo file X.md ... gửi telegram"), the producing task must write the file directly into outbox/<exact filename> — not the workspace root — so the delivery pipeline picks it up.
- BYTE DEPENDENCIES: "needs the data from T2" is NOT an input — bytes are. When a task needs another task's FILE output, the PRODUCER's instruction must name the exact artifact path it writes (e.g. "write findings to report.txt") and the CONSUMER's instruction must name that same path as its input (e.g. "read report.txt") — identical names, producer earlier, consumer depends_on the producer. A consumer that only says "send the report" with no file edge consumes the producer's RESULT TEXT via dependency_outputs — valid only for local (non-remote) producers.
- Keep task instructions concrete and verifiable; end with "then reply DONE."
- No prose, no markdown — JSON only.`;

export async function llmPlan(goal: string, cfg: LlmPlannerConfig): Promise<LlmPlanResult> {
  const maxTasks = cfg.maxTasks ?? LLM_PLANNER_DEFAULT_MAX_TASKS;
  const timeoutMs = cfg.timeoutMs ?? LLM_PLANNER_DEFAULT_TIMEOUT_MS;
  const apiKey = envGet(cfg.env, cfg.credentialEnv);
  const fetchImpl = cfg.fetchFn ?? fetch;

  // Fail closed on unusable plans: tasks=[] signals "no plan" — the caller
  // must reject submission rather than silently run the T1-only bookkeeping
  // plan, which would execute nothing yet report COMPLETED (seen live).
  const reject = (warnings: string[]): LlmPlanResult => ({
    tasks: [],
    source: "FALLBACK",
    model: cfg.model,
    warnings,
  });

  if (!apiKey) return reject(["LLM_PLANNER_NO_CREDENTIAL"]);
  if (!cfg.allowedCapabilities.length) return reject(["LLM_PLANNER_NO_CAPS"]);

  const userPrompt =
    `ALLOWED_CAPABILITIES: ${cfg.allowedCapabilities.sort().join(", ")}\n` +
    `MAX_TASKS: ${maxTasks}\n` +
    (cfg.capabilitySets?.length
      ? `EXECUTOR_CAPABILITY_SETS (one executor can serve a task only when its set covers ALL the task's required_capabilities): ${cfg.capabilitySets.map((s) => `[${s.join(", ")}]`).join(" ")}\n`
      : "") +
    (cfg.replanContext
      ? `\nREPLAN CONTEXT — this is a recovery replan after a governed failure:\n` +
        `failure_class: ${cfg.replanContext.failure_class}\n` +
        (cfg.replanContext.dependency_reason
          ? `dependency_reason: ${cfg.replanContext.dependency_reason} (the plan's artifact/dataflow shape could not be resolved at dispatch)\n`
          : "") +
        (cfg.replanContext.failed_task_key
          ? `failed_task: ${cfg.replanContext.failed_task_key}\n`
          : "") +
        `Do NOT re-emit the failed plan or a semantic equivalent (same topology, instructions, artifact edges, executor constraints, delivery behavior — plan_semantic_digest ${cfg.replanContext.failed_plan_semantic_digest ?? "n/a"}). ` +
        `Previously rejected candidate digests you must not reproduce: ${(cfg.replanContext.rejected_semantic_digests ?? []).join(", ") || "none"}.\n` +
        `Propose a genuinely different feasible plan for the SAME goal: change the artifact flow or task decomposition so the named failure cannot recur (e.g. make the needed artifact the explicit output of an earlier producer task and name the same path in the consumer's instruction). ` +
        `Preserve every unrelated constraint (capabilities allowed, DAG rules, telegram rules) and request no wider permissions than the failed plan.\n`
      : "") +
    `\nMISSION GOAL:\n${goal}`;

  // One attempt: fetch + parse + sanitize into a task DAG (or warnings).
  const attempt = async (): Promise<{ tasks: Array<Record<string, unknown>>; warnings: string[] }> => {
    let text: string;
    try {
      const resp = await fetchImpl(cfg.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: 2048,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) return { tasks: [], warnings: [`LLM_PLANNER_HTTP_${resp.status}`] };
      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      text = String(data.choices?.[0]?.message?.content ?? "");
    } catch (e) {
      const name = e instanceof Error ? e.name : "UNKNOWN";
      return { tasks: [], warnings: [`LLM_PLANNER_REQUEST_${name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "ERROR"}`] };
    }

    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch {
      return { tasks: [], warnings: ["LLM_PLAN_NO_JSON"] };
    }
    const rawTasks = (parsed as { tasks?: unknown })?.tasks;
    if (!Array.isArray(rawTasks) || !rawTasks.length) return { tasks: [], warnings: ["LLM_PLAN_NO_TASKS"] };

    const { tasks, warnings } = sanitizePlan(rawTasks as RawTask[], cfg.allowedCapabilities, maxTasks, cfg.capabilitySets);
    if (!tasks.length) return { tasks: [], warnings: ["LLM_PLAN_ALL_INVALID", ...warnings] };
    return { tasks, warnings };
  };

  // Degenerate output (fewer than MIN_TASKS usable tasks — a T1-only plan
  // only records the goal and performs no work) replans once, then rejects.
  const warnings: string[] = [];
  for (let i = 0; i < 2; i++) {
    const a = await attempt();
    if (a.tasks.length >= LLM_PLANNER_MIN_TASKS) {
      return { tasks: a.tasks, source: "LLM", model: cfg.model, warnings: [...warnings, ...a.warnings] };
    }
    warnings.push(...a.warnings, "LLM_PLAN_DEGENERATE");
  }
  return reject(warnings);
}
