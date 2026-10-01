#!/usr/bin/env node
// Phase C fake ACP agent — extends fake-acp-agent.mjs with per-MODEL
// failure-stage control so governed DSH multi-model failover can be tested:
// the selected model is learned at session/set_config_option("model") and
// keyed behaviors apply to that launch's session.
//
// Env knobs:
//   PAIR_TEST_BEHAVIORS   JSON map "<provider>:<model>" →
//                         "fail_setconfig" | "fail_prompt" | "hang_prompt" |
//                         "hang_after_effect"
//   PAIR_TEST_FAIL_INIT_ONCE  path — initialize errors once (file created),
//                         proving pre-dispatch failover across launches.
//   PAIR_TEST_MARKER      path — each prompt appends
//                         "<provider>:<model>" — records the side effect
//                         AND which model produced it (exactly-once proof).
//   PAIR_TEST_HANG_MS     ms — hang_after_effect waits this long before
//                         hanging (default 0 = immediate).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

let seq = 0;
const sessions = new Map();
const rl = readline.createInterface({ input: process.stdin });

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const err = (id, message) =>
  send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
// Behaviors may come from launch env (unit tests) OR a config file inside
// the pinned DSH_HOME (live E2E, where only governed pins reach the child).
let behaviors = JSON.parse(process.env.PAIR_TEST_BEHAVIORS ?? "{}");
let markerPath = process.env.PAIR_TEST_MARKER ?? null;
try {
  const home = process.env.DSH_HOME ?? process.env.PAIR_DSH_HOME;
  const cfgPath = home ? path.join(home, "pair-test-config.json") : null;
  const fileCfg =
    cfgPath && fs.existsSync(cfgPath)
      ? JSON.parse(fs.readFileSync(cfgPath, "utf8"))
      : null;
  if (fileCfg) {
    behaviors = { ...(fileCfg.behaviors ?? {}), ...behaviors };
    markerPath = markerPath ?? fileCfg.marker ?? null;
  }
} catch {
  /* malformed test config — keep env-provided behaviors */
}
const mark = (model) => {
  if (markerPath) fs.appendFileSync(markerPath, `${model}\n`);
};

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params = {} } = msg;
  if (id == null || method == null) return;
  switch (method) {
    case "initialize": {
      const once = process.env.PAIR_TEST_FAIL_INIT_ONCE;
      if (once && !fs.existsSync(once)) {
        fs.writeFileSync(once, "1");
        err(id, "ACP_INIT_FAIL_ONCE");
        return;
      }
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fake-acp-agent-phc", version: "0.0.1" },
          agentCapabilities: {
            loadSession: false,
            sessionCapabilities: { resume: true, list: true },
            promptCapabilities: {},
          },
          authMethods: [],
        },
      });
      break;
    }
    case "session/new": {
      const sessionId = `sess-${++seq}`;
      sessions.set(sessionId, { cwd: params.cwd, model: null });
      send({ jsonrpc: "2.0", id, result: { sessionId } });
      break;
    }
    case "session/set_config_option": {
      const sess = sessions.get(params.sessionId);
      let model = null;
      if (params.configId === "model" || params.config_id === "model") {
        try {
          const v = JSON.parse(String(params.value));
          model = Array.isArray(v) ? `${v[0]}:${v[1]}` : String(params.value);
        } catch {
          model = String(params.value);
        }
        if (sess) sess.model = model;
      }
      if (model && behaviors[model] === "fail_setconfig") {
        err(id, `ACP_SET_CONFIG_REJECTED:${model}`);
        return;
      }
      send({ jsonrpc: "2.0", id, result: {} });
      break;
    }
    case "session/set_mode":
      send({ jsonrpc: "2.0", id, result: {} });
      break;
    case "session/list":
      send({ jsonrpc: "2.0", id, result: { sessions: [...sessions.keys()].map((s) => ({ sessionId: s })) } });
      break;
    case "session/resume":
      send({ jsonrpc: "2.0", id, result: {} });
      break;
    case "session/close":
      sessions.delete(params.sessionId);
      send({ jsonrpc: "2.0", id, result: {} });
      break;
    case "session/cancel":
      send({ jsonrpc: "2.0", id, result: {} });
      break;
    case "session/prompt": {
      const sessionId = params.sessionId;
      const sess = sessions.get(sessionId);
      const cwd = sess?.cwd ?? process.cwd();
      const model = sess?.model ?? "unknown:unknown";
      const behavior = behaviors[model];
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_thought", text: `model=${model}` } },
      });
      if (behavior === "hang_prompt") {
        // Dispatched but never replies — adapter-side TIMEOUT; post-dispatch.
        break;
      }
      if (behavior === "hang_after_effect") {
        // Side effect DID happen, then the reply channel goes dark —
        // post-dispatch uncertainty (UNKNOWN territory, never a failover).
        const out = path.join(cwd, "agent_out.txt");
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, `acp:${sessionId}:${model}`);
        mark(model);
        const waitMs = Number(process.env.PAIR_TEST_HANG_MS ?? 0);
        setTimeout(() => {
          /* never respond */
        }, waitMs + 60000);
        break;
      }
      if (behavior === "fail_prompt") {
        // The task WAS dispatched (session live, prompt received) — record
        // the engagement, then fail the turn: post-dispatch failure.
        mark(model);
        err(id, `AGENT_FAILURE:${model}`);
        break;
      }
      {
        const out = path.join(cwd, "agent_out.txt");
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, `acp:${sessionId}:${model}`);
        mark(model);
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update: { sessionUpdate: "agent_message_chunk", text: "done" } },
        });
        send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      }
      break;
    }
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
  }
});
