#!/usr/bin/env node
// Fake `codex exec` with a real dwell time (~800ms) before completing —
// gives the E2E a genuinely long-running child so observe/collect spans
// multiple supervisor ticks (P18.4 E2E-1/E2E-9 realism).

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (args.includes("--version")) {
  console.log("codex-cli 0.0.1-fake-slow");
  process.exit(0);
}

const idx = (flag) => args.indexOf(flag);
const cwd = args.includes("-C") ? args[idx("-C") + 1] : process.cwd();
const finalPath = idx("--output-last-message") >= 0 ? args[idx("--output-last-message") + 1] : null;

let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  emit({ type: "thread.started", thread_id: "fake-thread-slow" });
  emit({ type: "turn.started" });
  setTimeout(() => {
    fs.writeFileSync(path.join(cwd, "codex_out.txt"), "codex:done");
    emit({ type: "item.completed", item: { type: "agent_message", text: "done" } });
    emit({ type: "turn.completed" });
    if (finalPath) {
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      fs.writeFileSync(
        finalPath,
        JSON.stringify({ status: "COMPLETED", summary: "codex did governed work (slow)" }),
      );
    }
    process.exit(0);
  }, 800);
});
