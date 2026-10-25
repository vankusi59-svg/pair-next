#!/usr/bin/env node
// Fake `codex exec` for CNI-1 tests — same JSONL protocol as
// fake-codex.mjs, plus it embeds the exact received argv in final.json
// (the adapter only reads status/summary; extra keys let the test
// inspect the real argv the adapter built).

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");

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
  const out = path.join(cwd, "codex_out.txt");
  fs.writeFileSync(out, "codex:done");
  emit({ type: "item.completed", item: { type: "agent_message", text: "done" } });
  emit({ type: "turn.completed" });
  if (finalPath) {
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(
      finalPath,
      JSON.stringify({
        status: "COMPLETED",
        summary: "codex did governed work",
        argv: args,
        // PAIR-side authority must not leak into the spawned child env.
        codex_network_env: process.env.PAIR_CODEX_NETWORK ?? null,
      }),
    );
  }
  // Planner-transport support: `codex exec --output-schema <file>` asks
  // for schema-constrained output. Answer per the schema's `required`:
  // the ping probe wants {"ok":true}; the plan schema wants a tasks DAG.
  const schemaPath = idx("--output-schema") >= 0 ? args[idx("--output-schema") + 1] : null;
  if (finalPath && schemaPath) {
    try {
      const required = JSON.parse(fs.readFileSync(schemaPath, "utf8"))?.required ?? [];
      // Only planner-shape schemas get a synthesized answer — the exec
      // dispatch schema keeps the generic evidence (argv/env) written
      // above so CNI-1-style assertions still see it.
      const body = required.includes("ok")
        ? { ok: true }
        : required.includes("tasks")
          ? {
              tasks: [
                { task_key: "T1", title: "reason step A", task_instruction: "analyze the mission goal", required_capabilities: ["REASONING"], depends_on: [] },
                { task_key: "T2", title: "reason step B", task_instruction: "summarize the analysis", required_capabilities: ["REASONING"], depends_on: ["T1"] },
              ],
            }
          : null;
      if (body !== null) {
        fs.mkdirSync(path.dirname(finalPath), { recursive: true });
        fs.writeFileSync(finalPath, JSON.stringify(body));
      }
    } catch { /* leave prior final.json content */ }
  }
  process.exit(0);
});
