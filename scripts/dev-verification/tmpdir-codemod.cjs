#!/usr/bin/env node
/* Codemod: src/__tests__/*.test.ts
 *   mkdtempSync(join(tmpdir(), "X-"))          → mkTmpDir("X-")
 *   mkdtempSync(path.join(os.tmpdir(), "X-"))  → mkTmpDir("X-")
 *   mkdtempSync(join(tmpdir(), `X-${v}-`))     → mkTmpDir(`X-${v}-`)
 * Injects `import { mkTmpDir } from "../test-utils/tmpdir.js";` after the
 * last import; removes `mkdtempSync` from node:fs named imports only when
 * zero callsites remain. Non-literal prefixes are left untouched. */
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "..", "src", "__tests__");
const CALL_RE =
  /mkdtempSync\(\s*(?:path\.)?join\(\s*(?:os\.)?tmpdir\(\)\s*,\s*(["'`])((?:(?!\1)[^\\]|\\.)*?)\1\s*\)/gs;

let files = 0, calls = 0;
for (const name of fs.readdirSync(DIR).filter((f) => f.endsWith(".test.ts"))) {
  const p = path.join(DIR, name);
  let s = fs.readFileSync(p, "utf8");
  let n = 0;
  s = s.replace(CALL_RE, (_m, q, inner) => {
    n++;
    return `mkTmpDir(${q}${inner}${q})`;
  });
  if (!n) continue;
  if (!/from\s+["']\.\.\/test-utils\/tmpdir\.js["']/.test(s)) {
    const imports = [...s.matchAll(/^import .*?from\s+["'][^"']+["'];?\s*$/gm)];
    const last = imports[imports.length - 1];
    if (last) {
      s =
        s.slice(0, last.index + last[0].length) +
        `\nimport { mkTmpDir } from "../test-utils/tmpdir.js";` +
        s.slice(last.index + last[0].length);
    }
  }
  if (!/mkdtempSync\(/.test(s)) {
    s = s
      .replace(/,\s*mkdtempSync\b/g, "")
      .replace(/\bmkdtempSync\s*,\s*/g, "")
      .replace(/import\s*{\s*}\s*from\s*["']node:fs["'];?\n?/g, "");
  }
  fs.writeFileSync(p, s);
  files++;
  calls += n;
  console.log(`${name}: ${n} callsites`);
}
console.log(`\nTOTAL: ${calls} callsites across ${files} files`);
