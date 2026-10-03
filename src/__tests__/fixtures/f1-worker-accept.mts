/* R2.7/R4.2 — true competing writer: separate Node process + separate
 * PairEvidenceStore connection to the SAME SQLite DB, synchronized by a
 * REAL barrier at the pre-BEGIN-IMMEDIATE seam (no sleeps):
 *   worker creates its own store → installs a TEST-ONLY wrapper on its
 *   OWN store.immediate() that writes READY, busy-waits for GO, then
 *   delegates to the ORIGINAL immediate — so every worker parks inside
 *   the transaction seam before the parent fires GO.
 * Loads CURRENT SOURCE via tsx — never a stale dist/. */
import fs from "node:fs";
const [, , modPath, dbPath, blobDir, eid, ex, name, src, goFile, readyFile, outFile] =
  process.argv;
const mod = (await import(modPath)) as Record<string, any>;
const { PairEvidenceStore, ArtifactAuthority } = mod;
const store = new PairEvidenceStore(dbPath);
const origImmediate = store.immediate.bind(store);
let armed = true;
store.immediate = (fn: () => unknown) => {
  if (armed) {
    armed = false;
    fs.writeFileSync(readyFile, "1");
    const dl = Date.now() + 60000;
    while (!fs.existsSync(goFile)) {
      if (Date.now() > dl) process.exit(3);
    }
  }
  return origImmediate(fn);
};
const auth = new ArtifactAuthority(store, { blobDir });
try {
  const r = auth.accept({
    execution_id: eid, producer_executor_id: ex, logical_name: name,
    source: { kind: "path", path: src }, channel: "LOCAL_EXECUTION",
    actor: "W", allow_post_result: true,
  });
  fs.writeFileSync(outFile, JSON.stringify({ ok: true, replayed: r.replayed }));
} catch (e: any) {
  fs.writeFileSync(outFile, JSON.stringify({ ok: false, code: e?.code ?? String(e) }));
}
store.close();
