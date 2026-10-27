const fs = require("fs");
function collect(p) {
  const d = JSON.parse(fs.readFileSync(p, "utf8"));
  const out = {};
  function walk(suite, file) {
    for (const spec of suite.specs || [])
      for (const t of spec.tests || []) {
        const rs = t.results || [];
        const r = rs[rs.length - 1] || {};
        let err = "";
        if (r.status && r.status !== "passed" && r.status !== "skipped")
          err = (r.errors || [])
            .map((e) => (typeof e === "string" ? e : e.message || e.stack || ""))
            .join("\n")
            .replace(/\x1b\[[0-9;]*m/g, "");
        out[file + " :: " + spec.title] = { file, title: spec.title, status: r.status || "?", err };
      }
    for (const c of suite.suites || []) walk(c, file || suite.file || "");
  }
  for (const s of d.suites || []) walk(s, s.file || "");
  return out;
}
const base = collect("docs/ui-v2/evidence/e2e-base-raw.json");
const head = collect("docs/ui-v2/evidence/e2e-head-raw.json");
const DYN =
  /\b(MSN|BIZ|OBJ|AGT|WI|PRN|PRR|RUN|EV|APR|TSK|WF|POL|REV|MSG|CNV|DRF|FIL|SEC|EXE|STP|CYC|PLN|SNP|JOB|GRA|ORG)_[A-Za-z0-9]+\b|\b[0-9a-f]{16,}\b|\b[0-9a-f-]{36}\b/g;
const PATH = /[A-Za-z]:[\\/][^\s'"<>)]+/g;
const norm = (s) =>
  s
    .split("\n")
    .filter((l) => !/^\s*at\s/.test(l))
    .join("\n")
    .replace(PATH, "<PATH>")
    .replace(DYN, "<ID>")
    .replace(/\s+/g, " ")
    .trim();
const fb = Object.keys(head).filter(
  (k) => base[k] && base[k].status !== "passed" && head[k].status !== "passed",
);
const rows = fb.map((k) => {
  const bn = norm(base[k].err),
    hn = norm(head[k].err);
  return {
    file: base[k].file,
    title: base[k].title,
    cls: bn === hn ? "same-substance" : "DIFFERS",
    bhead: bn.slice(0, 300),
    hhead: hn.slice(0, 300),
  };
});
const c = {};
for (const r of rows) c[r.cls] = (c[r.cls] || 0) + 1;
console.log(JSON.stringify(c));
for (const r of rows.filter((r) => r.cls === "DIFFERS")) {
  console.log("DIFF:", r.title.slice(0, 60));
  console.log(" B:", r.bhead);
  console.log(" H:", r.hhead);
}
fs.writeFileSync(
  "docs/ui-v2/evidence/e2e-signature-audit.json",
  JSON.stringify(rows, null, 1),
);
