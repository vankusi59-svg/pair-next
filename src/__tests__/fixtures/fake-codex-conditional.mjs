#!/usr/bin/env node
// Fake `codex exec` whose outcome is driven by the governed task's own
// prompt (stdin): instruction containing "always-fail" → FAILED;
// containing "fail-once" → fails on the first spawn in the workspace,
// succeeds on any later spawn (a governed RETRY is a new child in the
// same -C workspace). Otherwise → COMPLETED. Lets one fixture express
// deterministic per-task sibling failure + fail→retry→succeed chains
// without mutating the adapter (P18.4 E2E-3/E2E-9).

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (args.includes("--version")) {
  console.log("codex-cli 0.0.1-fake-conditional");
  process.exit(0);
}

const idx = (flag) => args.indexOf(flag);
const cwd = args.includes("-C") ? args[idx("-C") + 1] : process.cwd();
const finalPath = idx("--output-last-message") >= 0 ? args[idx("--output-last-message") + 1] : null;

let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  const wantFail = prompt.includes("always-fail");
  const marker = path.join(cwd, ".fail_once_marker");
  const wantOnce = prompt.includes("fail-once") && !fs.existsSync(marker);
  const failed = wantFail || wantOnce;
  emit({ type: "thread.started", thread_id: "fake-thread-cond" });
  emit({ type: "turn.started" });
  fs.writeFileSync(path.join(cwd, "codex_out.txt"), failed ? "codex:failed" : "codex:done");
  emit({ type: "item.completed", item: { type: "agent_message", text: failed ? "failed" : "done" } });
  emit({ type: "turn.completed" });
  if (wantOnce) fs.writeFileSync(marker, String(Date.now()));
  if (finalPath) {
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(
      finalPath,
      JSON.stringify(
        failed
          ? { status: "FAILED", summary: wantFail ? "always-fail task" : "transient failure" }
          : { status: "COMPLETED", summary: "codex did governed work" },
      ),
    );
  }
  process.exit(failed ? 1 : 0);
});
