const fs = require("fs");
const DIR = "src/__tests__";
const CALL_RE =
  /(?:fs\.)?mkdtempSync\(\s*(?:path\.)?join\(\s*(?:os\.)?tmpdir\(\)\s*,\s*(["'`])((?:(?!\1)[^\\]|\\.)*?)\1\s*\)/gs;
let total = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = dir + "/" + e.name;
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith(".ts")) continue;
    let s = fs.readFileSync(p, "utf8");
    let n = 0;
    s = s.replace(CALL_RE, (_m, q, inner) => { n++; return "mkTmpDir(" + q + inner + q + ")"; });
    if (!n) continue;
    const depth = p.split("/").length - 3;
    const rel = "../".repeat(depth) + "test-utils/tmpdir.js";
    if (!s.includes("test-utils/tmpdir")) {
      const imports = [...s.matchAll(/^import .*?from\s+["'][^"']+["'];?\s*$/gm)];
      const last = imports[imports.length - 1];
      if (last) s = s.slice(0, last.index + last[0].length) + '\nimport { mkTmpDir } from "' + rel + '";' + s.slice(last.index + last[0].length);
    }
    fs.writeFileSync(p, s);
    total += n;
    console.log(p + ": " + n);
  }
}
walk(DIR);
console.log("TOTAL: " + total);
