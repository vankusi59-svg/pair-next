/* K″ audit — static sweep v2: for every \b in a src/pair regex,
 * expand the enclosing alternation and flag any alternative whose
 * EDGE char adjacent to the \b is non-ASCII (JS \b is ASCII-only —
 * the alternative can never match there). */
const fs = require('fs');
const path = require('path');
const dir = 'src/pair';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
const na = (c) => c && /[^\x00-\x7F]/.test(c);
const out = [];
for (const f of files) {
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!line.includes('\\b')) return;
    const chunk = lines.slice(i, i + 4).join(' ');
    const cands = [];
    let m;
    const lit = /\/((?:\\.|[^\/\n])+)\/[gimsuy]{0,4}/g;
    while ((m = lit.exec(chunk))) if (m[1].includes('\\b')) cands.push(m[1]);
    const tpl = /`([^`]+)`/g;
    while ((m = tpl.exec(chunk))) if (m[1].includes('\\b')) cands.push(m[1]);
    for (const re of cands) {
      for (let j = 0; j < re.length; j++) {
        if (re[j] === '\\' && re[j + 1] === 'b') {
          const bad = [];
          // LEFT edge — the text before \b: last alternative(s) end char
          const before = re.slice(0, j);
          const openIdx = before.lastIndexOf('(');
          const seg = openIdx >= 0 ? before.slice(openIdx + 1) : before;
          for (const alt of seg.replace(/\(\?[:!<=][^)]*\)/g, '').split('|')) {
            const mm = alt.match(/[\p{L}\p{N}]/gu);
            if (mm && na(mm[mm.length - 1])) bad.push(`L:${mm[mm.length - 1]}<${alt.slice(-14)}`);
          }
          // RIGHT edge — alternatives inside the group that follows \b
          const after = re.slice(j + 2);
          const grp = after.match(/^\(?\?:?([^)]*)/);
          if (grp) {
            for (const alt of grp[1].split('|')) {
              const mm = alt.match(/[\p{L}\p{N}]/gu);
              if (mm && na(mm[0])) bad.push(`R:${mm[0]}>${alt.slice(0, 14)}`);
            }
          }
          if (bad.length) out.push(`${f}:${i + 1} [${bad.join(' ')}] :: ${re.slice(Math.max(0, j - 30), j + 60)}`);
          j++;
        }
      }
    }
  });
}
console.log(out.length ? out.join('\n') : 'NONE');
