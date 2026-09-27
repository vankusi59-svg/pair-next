#!/usr/bin/env node
// Fake ACP agent for P5 tests — a real subprocess speaking newline-delimited
// JSON-RPC. Stands in for `dsh --profile acp` / `codex-acp` where the vendor
// binary is absent: the transport, permission broker, and journal path are
// exercised for real; only the vendor implementation is substituted.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

let seq = 0;
const sessions = new Map();
const rl = readline.createInterface({ input: process.stdin });

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params = {} } = msg;
  if (id == null) return; // notifications ignored
  if (method == null) return; // responses to agent-initiated requests are handled by waitResponse listeners
  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fake-acp-agent", version: "0.0.1" },
          agentCapabilities: {
            loadSession: false,
            sessionCapabilities: { resume: true, list: true },
            promptCapabilities: {},
          },
          authMethods: [],
        },
      });
      break;
    case "session/new": {
      const sessionId = `sess-${++seq}`;
      sessions.set(sessionId, { cwd: params.cwd });
      send({ jsonrpc: "2.0", id, result: { sessionId } });
      break;
    }
    case "session/set_config_option":
      send({ jsonrpc: "2.0", id, result: {} });
      break;
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
      const text = (params.prompt ?? []).map((b) => b.text ?? "").join("\n");
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_thought", text: "working" } },
      });
      if (text.includes("HANG_FOREVER")) {
        // Never respond — drives adapter-side TIMEOUT.
        break;
      }
      if (text.includes("SHOULD_FAIL")) {
        send({ jsonrpc: "2.0", id, error: { code: -32000, message: "agent failure" } });
        break;
      }
      const finish = () => {
        // Do real work: write an artifact inside the governed workspace.
        const out = path.join(cwd, "agent_out.txt");
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, `acp:${sessionId}`);
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update: { sessionUpdate: "agent_message_chunk", text: "done" } },
        });
        send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      };
      if (text.includes("REQPERM")) {
        const reqId = 9000 + seq;
        const request = {
          jsonrpc: "2.0",
          id: reqId,
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: {
              kind: "edit",
              title: "Edit file",
              raw_input: { path: path.join(cwd, "agent_out.txt") },
            },
            options: [
              { kind: "allow_once", optionId: "allow1" },
              { kind: "reject_once", optionId: "deny1" },
            ],
          },
        };
        const waitResponse = (l2) => {
          try {
            const m2 = JSON.parse(l2);
            if (m2.id === reqId) {
              rl.off("line", waitResponse);
              if (m2.result?.outcome === "selected" || m2.result?.outcome?.outcome === "selected") {
                finish();
              } else {
                send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
              }
            }
          } catch { /* ignore */ }
        };
        rl.on("line", waitResponse);
        send(request);
        break;
      }
      finish();
      break;
    }
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
  }
});
