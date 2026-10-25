#!/usr/bin/env node
// Fake `codex exec` that fails immediately: emits the protocol, writes a
// FAILED final.json and exits non-zero. Used for born-terminal-failure
// and recovery-apply-continuation E2E (P18.4 E2E-6).

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (args.includes("--version")) {
  console.log("codex-cli 0.0.1-fake-fail");
  process.exit(0);
}

const idx = (flag) => args.indexOf(flag);
const cwd = args.includes("-C") ? args[idx("-C") + 1] : process.cwd();
const finalPath = idx("--output-last-message") >= 0 ? args[idx("--output-last-message") + 1] : null;

let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  emit({ type: "thread.started", thread_id: "fake-thread-fail" });
  emit({ type: "turn.started" });
  fs.writeFileSync(path.join(cwd, "codex_fail_marker.txt"), "codex:failed");
  emit({ type: "item.completed", item: { type: "agent_message", text: "failed" } });
  emit({ type: "turn.completed" });
  if (finalPath) {
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(
      finalPath,
      JSON.stringify({ status: "FAILED", summary: "codex reported failure" }),
    );
  }
  process.exit(1);
});
