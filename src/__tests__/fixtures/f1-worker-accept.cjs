/* R2.7 — true competing writer: separate Node process + separate
 * PairEvidenceStore connection to the SAME SQLite DB, gated on a
 * start-barrier file so writers hit the count/cap critical section
 * concurrently. */
const fs = require("fs");
const [, , modPath, dbPath, blobDir, eid, ex, name, src, goFile, outFile] = process.argv;
const { PairEvidenceStore, ArtifactAuthority } = require(modPath);
const deadline = Date.now() + 30000;
while (!fs.existsSync(goFile)) { if (Date.now() > deadline) process.exit(2); }
const store = new PairEvidenceStore(dbPath);
const auth = new ArtifactAuthority(store, { blobDir });
try {
  const r = auth.accept({
    execution_id: eid, producer_executor_id: ex, logical_name: name,
    source: { kind: "path", path: src }, channel: "LOCAL_EXECUTION",
    actor: "W", allow_post_result: true,
  });
  fs.writeFileSync(outFile, JSON.stringify({ ok: true, replayed: r.replayed }));
} catch (e) {
  fs.writeFileSync(outFile, JSON.stringify({ ok: false, code: e.code ?? String(e) }));
}
store.close();
