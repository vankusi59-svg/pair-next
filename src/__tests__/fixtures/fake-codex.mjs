#!/usr/bin/env node
// Fake `codex exec` for P5 tests — a real subprocess emitting the codex
// JSONL event protocol on stdout and honoring --output-last-message.

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");

// --version path used by probe
if (args.includes("--version")) {
  console.log("codex-cli 0.0.1-fake");
  process.exit(0);
}

const idx = (flag) => args.indexOf(flag);
const cwd = args.includes("-C") ? args[idx("-C") + 1] : process.cwd();
const finalPath = idx("--output-last-message") >= 0 ? args[idx("--output-last-message") + 1] : null;

let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  emit({ type: "thread.started", thread_id: "fake-thread-1" });
  emit({ type: "turn.started" });
  if (prompt.includes("SHOULD_FAIL")) {
    emit({ type: "turn.failed", error: { message: "agent failure" } });
    process.exit(3);
  }
  // Real side effect inside the governed workspace.
  const out = path.join(cwd, "codex_out.txt");
  fs.writeFileSync(out, "codex:done");
  emit({ type: "item.completed", item: { type: "agent_message", text: "done" } });
  emit({ type: "turn.completed" });
  if (finalPath) {
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(finalPath, JSON.stringify({ status: "COMPLETED", summary: "codex did governed work" }));
  }
  process.exit(0);
});
