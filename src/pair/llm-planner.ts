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
import {
  extractTaskDataflow,
  isPureBookkeepingTask,
} from "./plan-dataflow.js";

export const LLM_PLANNER_MAX_INSTRUCTION = 2000;
export const LLM_PLANNER_DEFAULT_MAX_TASKS = 5;
export const LLM_PLANNER_DEFAULT_TIMEOUT_MS = 20000;
/** PRV2-A §D — the planner emits WORK tasks only; PAIR injects the
 *  canonical bookkeeping task at the canonicalize seam. A plan is
 *  degenerate when it carries ZERO usable work tasks (a bookkeeping-only
 *  plan still performs no real work). */
export const LLM_PLANNER_MIN_TASKS = 1;

/** PRV2-A §E — adaptive work-task budget. The deterministic bookkeeping
 *  task is NOT a work task and is never counted. */
export const WORK_TASK_HARD_CEILING = 12;
export const WORK_TASK_BUDGET_SIMPLE = 4;
export const WORK_TASK_BUDGET_MEDIUM = 6;
export const WORK_TASK_BUDGET_COMPLEX = 10;

/** Deterministic complexity score → bounded budget (exact rule, §E):
 *    score = wordCount + 4*numberedListMarkers + 2*connectiveHits
 *    score ≤ 40 → simple (4); ≤ 120 → medium (6); else complex (10).
 *  Pure function of the goal text — the model cannot request an
 *  arbitrary budget. */
export function deriveWorkTaskBudget(goal: string): number {
  const g = String(goal ?? "");
  const words = g.split(/\s+/u).filter(Boolean).length;
  const enumerations = Math.min(
    (g.match(/\b\d+\s*[.)]/gu) ?? []).length,
    10,
  );
  const connectives = (
    g
      .toLowerCase()
      .match(/\b(và|and|then|sau đó|tiếp|rồi|cuối cùng|finally|also|song song)\b|[,;]/gu) ?? []
  ).length;
  const score = words + 4 * enumerations + 2 * connectives;
  if (score <= 40) return WORK_TASK_BUDGET_SIMPLE;
  if (score <= 120) return WORK_TASK_BUDGET_MEDIUM;
  return WORK_TASK_BUDGET_COMPLEX;
}

/** Effective budget = min(derived, configuredMax) under the absolute
 *  hard ceiling (12 work tasks). A configured cap only tightens. */
export function resolveWorkTaskBudget(goal: string, configuredMax?: number): number {
  const ceiling = Math.min(
    configuredMax ?? WORK_TASK_HARD_CEILING,
    WORK_TASK_HARD_CEILING,
  );
  return Math.max(1, Math.min(deriveWorkTaskBudget(goal), ceiling));
}

/** PRV2-A §D — a model-emitted task is bookkeeping-shaped when its
 *  filtered (allowed-vocabulary) capabilities are exactly
 *  {AUTOMATON_TASK_EXECUTION}: the ONLY thing it could do is PAIR's
 *  bookkeeping. PAIR injects bookkeeping itself, so such a task is
 *  normalized away at the canonicalize seam (never two bookkeeping
 *  authorities in one plan). */
export function isBookkeepingShapedTask(
  task: Record<string, unknown>,
  allowedCapabilities: string[],
): boolean {
  const capSet = new Set(allowedCapabilities);
  const caps = Array.isArray(task.required_capabilities)
    ? task.required_capabilities.map((c) => String(c)).filter((c) => capSet.has(c))
    : [];
  if (!caps.length || !caps.every((c) => c === "AUTOMATON_TASK_EXECUTION")) {
    return false;
  }
  return isPureBookkeepingTask({
    required_capabilities: caps,
    metadata: task.metadata,
  });
}

/** PRV2-A R1.A — AUTOMATON_TASK_EXECUTION is PAIR-reserved, not merely
 *  prompt-forbidden. A model emission is RESERVED-MISUSE when it carries
 *  AUTOMATON anywhere in its raw capability list and is NOT a pure
 *  bookkeeping-shaped task (the only emission PAIR is allowed to
 *  normalize away). Returns the task_key of the first misuse, else null.
 *  Callers must reject deterministically — never strip AUTOMATON from a
 *  mixed task and pretend the model requested something different. */
export function reservedAutomatonMisuseKey(
  rawTasks: Array<Record<string, unknown>>,
): string | null {
  for (const t of rawTasks ?? []) {
    const rawCaps = Array.isArray(t?.required_capabilities)
      ? (t.required_capabilities as unknown[]).map((c) => String(c))
      : [];
    if (!rawCaps.includes("AUTOMATON_TASK_EXECUTION")) continue;
    const pure = isPureBookkeepingTask({
      required_capabilities: rawCaps,
      metadata: t?.metadata,
    });
    if (!pure) return String(t?.task_key ?? "?");
  }
  return null;
}

/** Typed warning code for planner-layer reserved-misuse rejections. */
export const LLM_PLAN_RESERVED_CAPABILITY_WARNING =
  "LLM_PLAN_RESERVED_CAPABILITY_AUTOMATON";

/* ---------------- PRV2-A R2/R3 — current/external-data intent -------------
 * One canonical, conservative, deterministic detector distinguishing
 * LOCAL_CURRENT_STATE from CURRENT_EXTERNAL_INFORMATION. It powers the
 * canonical planner gate: a goal that explicitly needs current/external
 * data demands a legitimate NETWORK_ACCESS data-gathering task in the
 * canonical work plan, and a task instruction that explicitly requests
 * live/web fetching must carry NETWORK_ACCESS itself.
 *
 * R3.A — generic `current/currently/hiện tại` is LOCAL by default: it
 * cannot become external-data authority merely next to broad output
 * nouns (report/data/information), and any explicit local source
 * (repo/branch/workspace/file/CSV/code/project...) suppresses the
 * requirement entirely unless an online marker is present. Generic
 * current only counts with an explicit retrieval verb + retrievable
 * object ("get the current gold price"), or research intent against an
 * EXTERNAL subject ("analyze the current market").
 *
 * R3.B — research/retrieval intent covers research/analyze/nghiên cứu/
 * phân tích: the operator need not literally say fetch/search/internet.
 * A recency marker + research intent + external subject
 * ("research the latest GPT models") is current/external-data work. */

/** Strong recency markers — unambiguous "newest/now" vocabulary that can
 *  lift a research or retrieval request into current-data territory. */
const STRONG_CURRENCY_RE =
  /\b(today|tonight|latest|newest|live|real[-\s]?time|up[-\s]?to[-\s]?date|breaking|right\s+now)\b|hôm nay|mới nhất|mới đây|gần đây|trực tiếp|bây giờ|lúc này|ngày hôm nay/iu;

/** Generic current-state markers — ambiguous LOCAL-or-EXTERNAL; never
 *  sufficient alone (see R3.A rules). */
const GENERIC_CURRENT_RE = /\bcurrent(?:ly)?\b|hiện tại|hiện giờ|hiện nay/iu;

/** Explicit online/web markers — never bare "web" (a "web app" is not a
 *  network request) and never "website". */
const ONLINE_RE =
  /\b(the\s+web|world\s+wide\s+web|internet|online|web\s+search|search\s+the\s+web|google|bing|wikipedia|github)\b|trên mạng|trên internet|mạng internet/iu;

/** Explicit local sources — the "current state" lives on disk/in the
 *  repo, not on the network. Presence suppresses the requirement unless
 *  an online marker coexists. */
const LOCAL_SOURCE_RE =
  /\b(repos?|repository|branch(?:es)?|workspace|files?|csv|source\s+code|codebase|code|project(?:\s+state)?|commits?|diffs?|modules?|director(?:y|ies)|folders?|logs?|local(?:ly)?|disk|filesystem|monorepo)\b|mã nguồn|thư mục|tệp|dự án|nhánh|cục bộ|\brepo\b/iu;

/** Information-retrieval verbs. Word-bounded so "fetched", "scraper"
 *  do NOT match — only an explicit request to retrieve. */
const FETCH_VERB_RE =
  /\b(fetch(?:es)?|get|gets|getting|retrieve[sd]?|search(?:es)?|look\s?up|lookup|find|finds|browse[sd]?|scrape[sd]?|checks?|checking|gather(?:s|ing|ed)?|collect(?:s|ed|ing)?|quer(?:y|ies|ied)|pull(?:s|ing)?|download(?:s|ed|ing)?|tìm|tra|lấy)\b|tìm kiếm|tra cứu|kiểm tra|thu thập|xem tin/iu;

/** Research/analysis intent — the R3.B retrieval-class verbs that are
 *  not literal fetch words. */
const RESEARCH_RE =
  /\b(research(?:es|ed|ing)?|analyz(?:e[sd]?|ing)|analysis|study|studies|studied|studying|investigat(?:e[sd]?|ing)|survey(?:s|ed|ing)?|compar(?:e[sd]?|ing)|review(?:s|ed|ing)?)\b|nghiên cứu|phân tích|đánh giá|so sánh|khảo sát|tổng hợp/iu;

/** Subjects that only exist on the outside — versions, releases,
 *  products, prices, listings... A recency-marked research/fetch request
 *  about these is CURRENT_EXTERNAL_INFORMATION, not local state. */
const EXTERNAL_SUBJECT_RE =
  /\b(models?|versions?|releases?|apis?|products?|prices?|news|weather|rates?|exchanges?|forex|stocks?|markets?|crypto(?:currency)?|bitcoin|btc|eth|ethereum|gold|xau|xauusd|ea|mql[45]|packages?|listings?|frameworks?|tools?|providers?|offerings?|announcements?|feeds?|articles?|headlines?|trends?|quotes?|forecasts?|outlook|scores?|libraries?|sdks?|plugins?|services?|competitors?|events?)\b|giá|tin tức|thời tiết|thị trường|tỷ giá|mô hình|phiên bản|tin\b|\bbáo\b/iu;

/** Broad retrievable nouns — things one could gather, but weak alone
 *  (a "report" is usually authored, not fetched). */
const DATA_OBJECT_RE =
  /\b(price[sd]?|rates?|news|weather|stocks?|markets?|headlines?|trends?|updates?|information|data|reports?|scores?|results?|quotes?|articles?|forex|exchange|forecast|outlook|tin)\b|giá|tin tức|thời tiết|thị trường|tỷ giá|dữ liệu|thông tin|báo cáo|\bbáo\b/iu;

/** Does the GOAL explicitly intend current/external data? */
export function goalRequiresCurrentExternalData(goal: string): boolean {
  const g = String(goal ?? "");
  const online = ONLINE_RE.test(g);
  const strong = STRONG_CURRENCY_RE.test(g);
  const generic = GENERIC_CURRENT_RE.test(g);
  if (!online && !strong && !generic) return false;
  // R3.A — LOCAL_CURRENT_STATE: an explicit local source without an
  // online marker can never be an external-data requirement.
  if (LOCAL_SOURCE_RE.test(g) && !online) return false;
  const fetch = FETCH_VERB_RE.test(g);
  const research = RESEARCH_RE.test(g);
  const ext = EXTERNAL_SUBJECT_RE.test(g);
  const obj = DATA_OBJECT_RE.test(g);
  // Online or strong recency: retrieval/research intent + retrievable
  // subject → CURRENT_EXTERNAL_INFORMATION.
  if (online || strong) return (fetch || research) && (ext || obj);
  // Generic `current` only: explicit fetch verb + retrievable object
  // ("get the current gold price"), or research intent against an
  // EXTERNAL subject — never against a broad output noun.
  return (fetch && (ext || obj)) || (research && ext);
}

/** Does the task instruction explicitly request live/web fetching or
 *  recency-qualified research? Such a task MUST itself carry
 *  NETWORK_ACCESS. */
export function taskRequiresNetworkAccess(instruction: string): boolean {
  const t = String(instruction ?? "");
  const online = ONLINE_RE.test(t);
  const strong = STRONG_CURRENCY_RE.test(t);
  const generic = GENERIC_CURRENT_RE.test(t);
  if (!online && !strong && !generic) return false;
  if (LOCAL_SOURCE_RE.test(t) && !online) return false;
  const fetch = FETCH_VERB_RE.test(t);
  const research = RESEARCH_RE.test(t);
  if (online || strong) return fetch || research;
  // generic current: explicit fetch verb, or research on an external
  // subject — "analyze the current data" is local work, not misuse.
  return fetch || (research && EXTERNAL_SUBJECT_RE.test(t));
}

/** Does the instruction describe data-gathering work? Used to prove a
 *  NETWORK_ACCESS task is a legitimate gatherer — not a dummy carrying
 *  the capability. */
export function instructionIsDataGathering(instruction: string): boolean {
  const t = String(instruction ?? "");
  const fetch = FETCH_VERB_RE.test(t);
  const research = RESEARCH_RE.test(t);
  return (
    (fetch || research) &&
    (DATA_OBJECT_RE.test(t) ||
      EXTERNAL_SUBJECT_RE.test(t) ||
      ONLINE_RE.test(t) ||
      STRONG_CURRENCY_RE.test(t) ||
      GENERIC_CURRENT_RE.test(t))
  );
}

/* ---------------- PRV2-A R4 — goal↔task subject binding -------------------
 * The NETWORK_ACCESS task satisfying a goal-level current-data
 * obligation must gather data RELEVANT to that obligation. A bounded
 * lexical proof: extract the canonical external-subject lexemes present
 * in each text (same vocabulary family as the detector, singular-
 * normalized, small alias map) and require a non-empty overlap. No
 * semantic classifier; one shared canonical lexeme is sufficient
 * binding — conservative like the rest of the detector. */

const SUBJECT_LEXEMES = new Set([
  "model", "version", "release", "api", "product", "price", "news",
  "weather", "rate", "exchange", "forex", "stock", "market", "crypto",
  "bitcoin", "ethereum", "gold", "ea", "mql4", "mql5", "package",
  "listing", "framework", "tool", "provider", "offering", "announcement",
  "feed", "article", "headline", "trend", "quote", "forecast", "outlook",
  "score", "library", "sdk", "plugin", "service", "competitor", "event",
  "update", "information", "data", "report", "result",
]);

const SUBJECT_ALIAS: Record<string, string> = {
  btc: "bitcoin", eth: "ethereum", xau: "gold", xauusd: "gold",
};

/** Vietnamese subject phrases → canonical English keys so a VI goal
 *  binds a VI task by subject, not by literal wording. */
const VI_SUBJECT_PHRASES: Array<[RegExp, string]> = [
  [/mô hình/iu, "model"], [/phiên bản/iu, "version"],
  [/tin tức|\btin\b|\bbáo\b/iu, "news"], [/thời tiết/iu, "weather"],
  [/thị trường/iu, "market"], [/tỷ giá/iu, "rate"],
  [/giá/iu, "price"], [/\bvàng\b/iu, "gold"],
  [/dữ liệu/iu, "data"], [/thông tin/iu, "information"],
  [/báo cáo/iu, "report"],
];

/** Canonical external-subject keys present in a text (e.g. "models" →
 *  "model", "btc" → "bitcoin", "giá vàng" → {"price","gold"}). */
export function externalSubjectKeys(text: string): Set<string> {
  const t = String(text ?? "");
  const keys = new Set<string>();
  for (const m of t.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    let key = SUBJECT_ALIAS[m[0]] ?? m[0];
    if (!SUBJECT_LEXEMES.has(key) && key.endsWith("s")) {
      const stem = key.slice(0, -1);
      if (SUBJECT_LEXEMES.has(stem)) key = stem;
    }
    if (SUBJECT_LEXEMES.has(key)) keys.add(key);
  }
  for (const [re, key] of VI_SUBJECT_PHRASES) if (re.test(t)) keys.add(key);
  return keys;
}

/** Does the task instruction plausibly gather the subject the goal's
 *  current-data obligation is about? One shared canonical lexeme is
 *  sufficient binding. When the goal yields no lexemes at all the
 *  subject proof is vacuous — the plain data-gathering check applies. */
export function instructionSatisfiesGoalSubject(
  instruction: string,
  goal: string,
): boolean {
  const goalKeys = externalSubjectKeys(goal);
  if (goalKeys.size === 0) return true;
  const taskKeys = externalSubjectKeys(instruction);
  for (const k of taskKeys) if (goalKeys.has(k)) return true;
  return false;
}

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

/** Extract the first balanced {...} JSON object from LLM text output.
 *  Exported as extractPlanJson for the Codex CLI planner transport
 *  (CPL-1) — every transport parses plan text through ONE seam. */
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
export const extractPlanJson = extractJson;

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

Output ONLY a JSON object: {"tasks": [...]}. Each task is a WORK task — work that serves the goal directly:
- "task_key": "T1", "T2", ... sequential
- "title": short label
- "task_instruction": self-contained instruction for an autonomous executor agent. It must name the REAL WORK the operator asked for — carry the goal's subject matter verbatim into the instruction (e.g. goal "phân tích giá vàng hôm nay" → instruction "analyze today's gold price using ICT concepts — market structure, liquidity, order blocks — and write findings to analysis.txt"). NEVER emit meta-instructions like "analyze the goal" or "summarize the mission". Mention workspace-relative file paths when files must be read/written (e.g. "read mission_goal.txt", "write result to out.txt"). The executor runs inside the mission workspace.
- "required_capabilities": subset of the ALLOWED_CAPABILITIES list — pick the minimum needed. The router maps capabilities to executors; you never name an executor.
- "depends_on": earlier task_keys only (DAG, acyclic). MUST list every task whose output this task needs: if it reads/copies/delivers a file another task writes, or uses its returned result, the producer goes in depends_on. Undeclared inputs make the task run before its data exists. Independent tasks stay parallel — only real producers are dependencies.

Rules:
- Emit ONLY genuine work tasks. PAIR injects its own bookkeeping task (recording the goal) before the plan is committed — NEVER emit a task whose purpose is recording the goal, and NEVER request AUTOMATON_TASK_EXECUTION (it is reserved for PAIR's injected bookkeeping task).
- 1 to WORK_TASKS work tasks. Every task must exist for at least one concrete reason: a distinct deliverable/output, a distinct capability boundary, independently parallelizable work, a verification/review boundary, or a side-effect boundary. Do NOT split trivial sequential prose work into microtasks. Prefer analysis/reasoning steps (REASONING) for thinking work, CODE_GENERATION/PYTHON_EXECUTION for code, SHELL_EXECUTION for running things, FILE_OPERATIONS for pure file writes.
- CURRENT/EXTERNAL DATA: if the goal needs current/external information (words like "hôm nay", "hiện tại", "giá", "tin tức", "mới nhất", "today", "current", "latest", "news", "price"), the data-gathering task MUST include NETWORK_ACCESS in required_capabilities — it is a real routing fact: only an executor currently authorized for network access may serve the task, and the Mission Router chooses WHICH one. You describe WHAT the task needs; never assume a specific executor has or lacks internet. Instruct the task to RETURN the full findings as its final result text, and name produced files explicitly when a downstream task must read them.
- SOFTWARE WORK: when the goal asks to build or fix software (xây/build/create a website/app/tool/bot/script, viết code, fix bug, deploy), pick the minimum capability set the job requires (CODE_GENERATION, CODE_EDITING, SHELL_EXECUTION, PYTHON_EXECUTION, FILE_OPERATIONS). You describe the work — the router decides which executor satisfies the set.
- REMOTE DATAFLOW CONTRACT: tasks carrying REMOTE_CLOUD_TASK_EXECUTION / AUTONOMOUS_CODE_EXECUTION may execute remotely — their result text comes back, and their uploaded files land as canonical artifacts. A downstream task may depend on a remote task ONLY when it explicitly declares the produced artifact as an input (read the file it produces — name the artifact in its instruction or worker_spec); a remote dep with no declared artifact edge is rejected. TELEGRAM_DELIVERY tasks always may depend on remote tasks (they receive the remote result text through dependency_outputs).
- VISUAL DELIVERABLES: a chart computed from data the plan already produces is ordinary compute work (e.g. PYTHON_EXECUTION); a screenshot of a live website needs a task that includes NETWORK_ACCESS; a generated image is only possible when a governed image-generation capability exists in ALLOWED_CAPABILITIES. If a visual file is produced by a task that may execute remotely, it must be uploaded via the outbox endpoint described in that task's prompt — a file left on a remote machine is unusable. Followed by a TELEGRAM_DELIVERY task when the goal also asks to send it to the operator.
- TELEGRAM_DELIVERY (when ALLOWED): ONLY when the goal EXPLICITLY asks to send/deliver named output to Telegram (gửi tele/telegram, báo qua telegram, send/deliver to telegram) — never add it for a goal that merely mentions a file, an outbox, or completion. Add it as a DAG-leaf task with capability TELEGRAM_DELIVERY, depending ONLY on the tasks that produce what the goal asked to be sent. PAIR pins the delivery manifest, the canonical output language, and the final delivery instruction from the operator request — the plan does not choose what may be sent, in which language, or how. Instruction placeholder: "Stage the manifested artifacts into outbox/ unchanged, then reply DONE." (PAIR rewrites it canonically.)
- FILE DELIVERABLES: when the goal names a file to create AND asks to send it (e.g. "tạo file X.md ... gửi telegram"), the producing task must write the file directly into outbox/<exact filename> — not the workspace root — so the delivery pipeline picks it up.
- BYTE DEPENDENCIES: "needs the data from T2" is NOT an input — bytes are. When a task needs another task's FILE output, the PRODUCER's instruction must name the exact artifact path it writes (e.g. "write findings to report.txt") and the CONSUMER's instruction must name that same path as its input (e.g. "read report.txt") — identical names, producer earlier, consumer depends_on the producer. A consumer that only says "send the report" with no file edge consumes the producer's RESULT TEXT via dependency_outputs — valid only for local (non-remote) producers.
- Keep task instructions concrete and verifiable; end with "then reply DONE."
- No prose, no markdown — JSON only.`;

/**
 * The ONE canonical planner prompt — shared by every planner transport
 * (OpenAI-compatible HTTP and the Codex CLI planner provider, CPL-1).
 * Any drift between transports is a contract violation: all candidates
 * must answer the same prompt under the same task-shape authority.
 */
export function buildPlannerUserPrompt(
  goal: string,
  cfg: {
    allowedCapabilities: string[];
    capabilitySets?: string[][];
    maxTasks?: number;
    replanContext?: LlmPlannerConfig["replanContext"];
  },
): string {
  const workTasks = resolveWorkTaskBudget(goal, cfg.maxTasks);
  return (
    `ALLOWED_CAPABILITIES: ${cfg.allowedCapabilities.sort().join(", ")}\n` +
    `WORK_TASKS: ${workTasks}\n` +
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
    `\nMISSION GOAL:\n${goal}`
  );
}

export function plannerSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

export async function llmPlan(goal: string, cfg: LlmPlannerConfig): Promise<LlmPlanResult> {
  const maxTasks = resolveWorkTaskBudget(goal, cfg.maxTasks);
  // R1.A — sanitize keeps the PAIR-reserved AUTOMATON key ONLY so a pure
  // bookkeeping-shaped emission survives to the canonicalize seam for
  // deterministic normalization (drop + dependency remap onto injected
  // T1). It is never model-visible (ALLOWED_CAPABILITIES renders
  // cfg.allowedCapabilities verbatim) and can never survive as a work
  // task — reservedAutomatonMisuseKey above throws the candidate first.
  const sanitizeCaps = cfg.allowedCapabilities.includes("AUTOMATON_TASK_EXECUTION")
    ? cfg.allowedCapabilities
    : [...cfg.allowedCapabilities, "AUTOMATON_TASK_EXECUTION"];
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

  const userPrompt = buildPlannerUserPrompt(goal, cfg);

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
    // PRV2-A R1.A — reserved-capability misuse (AUTOMATON outside pure
    // bookkeeping shape) fails the candidate deterministically; it is
    // never stripped-and-pretended into a different request.
    const reservedKey = reservedAutomatonMisuseKey(rawTasks as Array<Record<string, unknown>>);
    if (reservedKey) return { tasks: [], warnings: [`${LLM_PLAN_RESERVED_CAPABILITY_WARNING}:${reservedKey}`] };
    const { tasks, warnings } = sanitizePlan(rawTasks as RawTask[], sanitizeCaps, maxTasks, cfg.capabilitySets);
    if (!tasks.length) return { tasks: [], warnings: ["LLM_PLAN_ALL_INVALID", ...warnings] };
    return { tasks, warnings };
  };

  // Degenerate output (ZERO usable work tasks — a bookkeeping-only plan
  // performs no work) replans once, then rejects.
  const warnings: string[] = [];
  for (let i = 0; i < 2; i++) {
    const a = await attempt();
    const usable = a.tasks.filter(
      (t) => !isBookkeepingShapedTask(t, sanitizeCaps),
    );
    if (usable.length >= LLM_PLANNER_MIN_TASKS) {
      return { tasks: a.tasks, source: "LLM", model: cfg.model, warnings: [...warnings, ...a.warnings] };
    }
    warnings.push(...a.warnings, "LLM_PLAN_DEGENERATE");
  }
  return reject(warnings);
}
