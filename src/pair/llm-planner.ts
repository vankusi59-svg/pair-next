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

export const LLM_PLANNER_MAX_INSTRUCTION = 2000;
export const LLM_PLANNER_DEFAULT_MAX_TASKS = 5;
export const LLM_PLANNER_DEFAULT_TIMEOUT_MS = 20000;

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
 * side (returned as refs, not local workspace files). A remote task must be a
 * DAG leaf: a downstream local task cannot consume a remote artifact.
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
    // Remote tasks are leaves — drop the task rather than prune the edge when
    // a later task tries to depend on remote output that can never be local.
    // Exception: TELEGRAM_DELIVERY — it consumes the remote task's returned
    // result text via dependency_outputs (not remote files), so that edge is
    // safe and is how remote-produced reports reach the operator.
    const isTelegramDelivery = caps.includes("TELEGRAM_DELIVERY");
    const deps = Array.isArray(t.depends_on)
      ? [...new Set(t.depends_on.map((d) => String(d)).filter((d) => seen.has(d)))]
      : [];
    if (!isTelegramDelivery && deps.some((d) => remoteKeys.has(d))) {
      warnings.push(`DROP_REMOTE_DEPENDENT:${key}`);
      continue;
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
- "depends_on": earlier task_keys only (DAG, acyclic).

Rules:
- Always include a first task T1 that records the goal into mission_goal.txt via capability AUTOMATON_TASK_EXECUTION.
- 2 to MAX_TASKS tasks. Prefer analysis/reasoning steps (REASONING) for thinking work, CODE_GENERATION/PYTHON_EXECUTION for code, SHELL_EXECUTION for running things, FILE_OPERATIONS/AUTOMATON_TASK_EXECUTION for pure file writes.
- LIVE DATA: if the goal needs current/external information (words like "hôm nay", "hiện tại", "giá", "tin tức", "mới nhất", "today", "current", "latest", "news", "price") that local executors cannot fetch — local executors have NO internet — the data-gathering task MUST use REMOTE_CLOUD_TASK_EXECUTION (the remote executor has a real browser/network). Instruct it to RETURN the full findings as its final result text — files it writes stay remote and are invisible locally.
- REMOTE_CLOUD_TASK_EXECUTION / AUTONOMOUS_CODE_EXECUTION run on a REMOTE executor: their files stay remote (only the returned result text comes back). Such a task must be a DAG leaf — the ONLY dependent allowed is a TELEGRAM_DELIVERY task, which receives the remote result text through dependency_outputs.
- VISUAL DELIVERABLES: if the goal asks for a real chart, screenshot, or image (chụp ảnh/biểu đồ/chart/screenshot), the remote task must capture it with its browser AND upload the file via the outbox endpoint described in its prompt — the file is unusable if it stays on the remote machine. Followed by a TELEGRAM_DELIVERY task when the goal also asks to send it to the operator.
- TELEGRAM_DELIVERY (when ALLOWED): when the goal asks to send/deliver results to Telegram (gửi tele/telegram, báo qua telegram, send to telegram), add a DAG-leaf task with capability TELEGRAM_DELIVERY. Instruction: "Read the upstream tasks' returned results in dependency_outputs, compose the final operator-facing report in the goal's language as plain text, write it to outbox/report.txt. If earlier tasks produced files the operator must receive (named files like X.md, reports, images): copy each into outbox/ keeping its filename — files outside outbox/ are never delivered. Then reply DONE." It must depend_on every task that produces content for the report — INCLUDING remote tasks (their result text is delivered via dependency_outputs).
- FILE DELIVERABLES: when the goal names a file to create AND asks to send it (e.g. "tạo file X.md ... gửi telegram"), the producing task must write the file directly into outbox/<exact filename> — not the workspace root — so the delivery pipeline picks it up.
- Keep task instructions concrete and verifiable; end with "then reply DONE."
- No prose, no markdown — JSON only.`;

export async function llmPlan(goal: string, cfg: LlmPlannerConfig): Promise<LlmPlanResult> {
  const maxTasks = cfg.maxTasks ?? LLM_PLANNER_DEFAULT_MAX_TASKS;
  const timeoutMs = cfg.timeoutMs ?? LLM_PLANNER_DEFAULT_TIMEOUT_MS;
  const apiKey = envGet(cfg.env, cfg.credentialEnv);
  const fetchImpl = cfg.fetchFn ?? fetch;

  const fallback = (warnings: string[]): LlmPlanResult => ({
    tasks: fallbackTasks(goal),
    source: "FALLBACK",
    model: cfg.model,
    warnings,
  });

  if (!apiKey) return fallback(["LLM_PLANNER_NO_CREDENTIAL"]);
  if (!cfg.allowedCapabilities.length) return fallback(["LLM_PLANNER_NO_CAPS"]);

  const userPrompt =
    `ALLOWED_CAPABILITIES: ${cfg.allowedCapabilities.sort().join(", ")}\n` +
    `MAX_TASKS: ${maxTasks}\n` +
    (cfg.capabilitySets?.length
      ? `EXECUTOR_CAPABILITY_SETS (one executor can serve a task only when its set covers ALL the task's required_capabilities): ${cfg.capabilitySets.map((s) => `[${s.join(", ")}]`).join(" ")}\n`
      : "") +
    `\nMISSION GOAL:\n${goal}`;

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
    if (!resp.ok) return fallback([`LLM_PLANNER_HTTP_${resp.status}`]);
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    text = String(data.choices?.[0]?.message?.content ?? "");
  } catch (e) {
    const name = e instanceof Error ? e.name : "UNKNOWN";
    return fallback([`LLM_PLANNER_REQUEST_${name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "ERROR"}`]);
  }

  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch {
    return fallback(["LLM_PLAN_NO_JSON"]);
  }
  const rawTasks = (parsed as { tasks?: unknown })?.tasks;
  if (!Array.isArray(rawTasks) || !rawTasks.length) return fallback(["LLM_PLAN_NO_TASKS"]);

  const { tasks, warnings } = sanitizePlan(rawTasks as RawTask[], cfg.allowedCapabilities, maxTasks, cfg.capabilitySets);
  if (!tasks.length) return fallback(["LLM_PLAN_ALL_INVALID", ...warnings]);
  return { tasks, source: "LLM", model: cfg.model, warnings };
}
