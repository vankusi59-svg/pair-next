#!/usr/bin/env node
// Fake `codex exec` that fails exactly once per workspace, then succeeds:
// the first spawn in a given -C <workspace> writes a `.flaky_once` marker
// and exits 1; every later spawn (e.g. a governed RETRY dispatch — a new
// child process in the same workspace) completes. Exercises the
// fail→retry→succeed recovery chain end-to-end (P18.4 E2E-9).

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (args.includes("--version")) {
  console.log("codex-cli 0.0.1-fake-flaky");
  process.exit(0);
}

const idx = (flag) => args.indexOf(flag);
const cwd = args.includes("-C") ? args[idx("-C") + 1] : process.cwd();
const finalPath = idx("--output-last-message") >= 0 ? args[idx("--output-last-message") + 1] : null;

let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  const marker = path.join(cwd, ".flaky_once");
  const firstRun = !fs.existsSync(marker);
  emit({ type: "thread.started", thread_id: "fake-thread-flaky" });
  emit({ type: "turn.started" });
  fs.writeFileSync(path.join(cwd, "codex_out.txt"), firstRun ? "codex:flaky-fail" : "codex:done");
  emit({ type: "item.completed", item: { type: "agent_message", text: firstRun ? "flaky fail" : "done" } });
  emit({ type: "turn.completed" });
  if (firstRun) {
    fs.writeFileSync(marker, String(Date.now()));
    if (finalPath) {
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      fs.writeFileSync(
        finalPath,
        JSON.stringify({ status: "FAILED", summary: "transient codex failure" }),
      );
    }
    process.exit(1);
  }
  if (finalPath) {
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(
      finalPath,
      JSON.stringify({ status: "COMPLETED", summary: "codex recovered on retry" }),
    );
  }
  process.exit(0);
});
