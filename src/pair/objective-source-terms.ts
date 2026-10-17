/**
 * P15.2W — deterministic source-term preservation for delegated goals.
 *
 * Problem: the CEO LLM paraphrases workstream goals and can drop exact
 * operational literals (URLs, filesystem paths, API routes, filenames,
 * quoted keys) the Objective statement requires downstream agents to
 * use verbatim ("the specified API"). Delegated children inherit the
 * paraphrased goal unchanged (work-graph delegates goal = parent.goal),
 * so every loss is committed into canonical authority.
 *
 * Solution: at decomposition-commit time, extract the literal set from
 * the canonical Objective statement and append the literals each
 * workstream goal failed to preserve as a deterministic
 * `[source terms: …]` trailer. Enrichment is a commit-time projection
 * on the P14 child specs only — the normalized proposal and its digest
 * are computed from the raw proposal and never see the trailer, so
 * replay/amend semantics are unchanged.
 *
 * R2 audit corrections:
 *  - Attribution REMOVED. Token-overlap clause matching cannot prove
 *    which workstream owns a literal — a confident-but-wrong claim
 *    starved siblings (R1-F1) and even a PARTIAL claim starved real
 *    literals (R2-F1). Preservation beats attribution precision:
 *    every workstream receives every literal its goal lacks.
 *  - URL/route tails are balance-aware: `()[]{} `inside literals are
 *    kept, prose-wrapping closers and sentence punctuation are
 *    stripped (R2-F2).
 *  - Bounds fail closed, never silently truncate: >24 unique literals
 *    or a matched literal >160 chars aborts the commit inside the
 *    atomic transaction (R2-F3).
 *
 * R3 audit corrections:
 *  - `+`/`=` at a URL tail are literal data (base64 signatures end in
 *    `+`/`=`; empty-valued params end in `=`) — tail-stripping keeps
 *    them; prose punctuation never attaches to a URL without a space
 *    (R3-F1).
 *  - The quoted keep-pattern is bounded at {1,160}; a longer quoted
 *    run can never match it, so an oversized quoted literal would be
 *    silently ignored instead of reaching the cap check. A dedicated
 *    pre-scan under the same boundary rules fails closed on any
 *    length (R3-F2).
 */

import { IntegrityError } from "./errors.js";

/** Same bound as `boundedStr(goal, 2048)` in objective-workstream.ts —
 *  trailers must live inside the canonical child-goal cap. */
const CHILD_GOAL_CAP = 2048;
/** One literal never exceeds 160 chars — a longer run is prose, not a
 *  source term. Exceeding it fails closed, never silently skips. */
const LITERAL_CAP = 160;
/** A statement carrying more source terms than this cannot be fully
 *  preserved inside the goal cap — fail closed, never silently drop. */
const STATEMENT_LITERAL_CAP = 24;

const TRAILER_PREFIX = "\n\n[source terms: ";
const TRAILER_SUFFIX = "]";

function literalsFail(detail: string): never {
  throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_WORKSTREAM_LITERALS", detail);
}

/**
 * Literal families. Ordering inside the array is irrelevant — matches
 * are re-sorted by statement position — but each regex must be `g`.
 * URLs keep `()[]{}?&=%` (balanced tail-stripping removes only prose
 * wrappers); POSIX/API routes take an optional `?query` tail and use a
 * lookbehind so `https://`, `a/b` fractions and `and/or` prose never
 * count as routes.
 */
const LITERAL_PATTERNS: RegExp[] = [
  /https?:\/\/[^\s"'<>]+/g,
  /\b[A-Za-z]:[\\/][^\s"'<>|]+/g,
  /(?<![\w:/])\/[\w][\w\-./]*(?:\?[^\s"'<>]*)?/g,
  /\b\w[\w\-]*(?:\.\w[\w\-]*)*\.(?:html?|md|markdown|txt|json|csv|xml|ya?ml|toml|ini|cfg|log|mjs|cjs|jsx?|tsx?|py|ps1|sh|bat|css|png|jpe?g|gif|svg|pdf|zip|sql|db|rss)\b/gi,
  /(?<!\w)"[^"\n]{1,160}"(?!\w)|(?<!\w)'[^'\n]{1,160}'(?!\w)/g,
  /\b(?:local|session)Storage\s+key\s+(?:["'`][\w][\w.\-]*["'`]|[\w][\w.\-]*)/gi,
];

/** R3-F2 — detector for quoted literals too long to ever match the
 *  bounded keep-pattern above. Same boundary rules, so a run that
 *  would have been a literal had it fit still reaches validation and
 *  fails closed instead of silently vanishing. The quantifier is
 *  deliberately open-ended: ANY oversized quoted run must fail,
 *  bounded only by the statement's own length. */
const OVERSIZED_QUOTED_LITERAL =
  /(?<!\w)"[^"\n]{161,}"(?!\w)|(?<!\w)'[^'\n]{161,}'(?!\w)/g;

/** Patterns whose match gets balanced tail-stripping — URLs, Windows
 *  paths, routes, filenames. Quoted/storage literals keep their exact
 *  spelling (quotes are data, not punctuation). */
const TAIL_STRIP_PATTERNS = 4;

/**
 * Strip characters the match greedily swallowed from prose, never from
 * the literal itself: sentence terminators, dangling query delimiters,
 * and closers `)]}` that outnumber their openers inside the match —
 * `Function_(mathematics)` keeps its parens, `https://x/a)` drops the
 * prose paren. `'`/`"` are also stripped here because quoted literals
 * never reach this path. `=` and `+` are NEVER stripped: they are
 * legal URL data (base64 signatures, empty-valued params) and cannot
 * appear as prose attached to a literal — prose always separates them
 * with whitespace, which already ended the match.
 */
function stripLiteralTail(text: string): string {
  let s = text;
  for (;;) {
    if (!s) return s;
    const last = s[s.length - 1]!;
    if (".,;:!?&'\"".includes(last) || last === "\\" || last === ">") {
      s = s.slice(0, -1);
      continue;
    }
    if (last === ")" || last === "]" || last === "}") {
      const open = last === ")" ? "(" : last === "]" ? "[" : "{";
      const opens = s.split(open).length - 1;
      const closes = s.split(last).length - 1;
      if (closes > opens) {
        s = s.slice(0, -1);
        continue;
      }
      return s;
    }
    return s;
  }
}

/**
 * Extract the statement's exact operational literals, deterministic:
 * statement-position order, deduplicated, substrings of already-kept
 * longer literals dropped (`mc-mini.html` inside `C:\…\mc-mini.html`).
 * Bounds are authority bounds: more than 24 unique literals or a
 * matched literal over 160 chars fails closed —
 * preservation must never silently truncate and still report success.
 */
export function extractStatementLiterals(statement: string): string[] {
  if (typeof statement !== "string" || !statement) return [];
  OVERSIZED_QUOTED_LITERAL.lastIndex = 0;
  if (OVERSIZED_QUOTED_LITERAL.test(statement)) {
    literalsFail(`quoted literal exceeds ${LITERAL_CAP} chars`);
  }
  const hits: Array<{ index: number; text: string }> = [];
  for (const [pi, re] of LITERAL_PATTERNS.entries()) {
    re.lastIndex = 0;
    for (let m = re.exec(statement); m !== null; m = re.exec(statement)) {
      const text = pi < TAIL_STRIP_PATTERNS
        ? stripLiteralTail(m[0].trim())
        : m[0].trim();
      if (!text) continue;
      if (text.length > LITERAL_CAP) {
        literalsFail(`literal exceeds ${LITERAL_CAP} chars`);
      }
      hits.push({ index: m.index, text });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  const kept: string[] = [];
  for (const h of hits) {
    if (kept.includes(h.text)) continue;
    if (kept.some((k) => k.includes(h.text))) continue;
    kept.push(h.text);
  }
  if (kept.length > STATEMENT_LITERAL_CAP) {
    literalsFail(`>${STATEMENT_LITERAL_CAP} source literals — cannot preserve fully`);
  }
  return kept;
}

/**
 * Commit-time projection: return child specs whose goals carry the
 * statement literals they failed to preserve, as a `[source terms: …]`
 * trailer. Every workstream receives every literal its goal does not
 * already contain verbatim — preservation over attribution, so no
 * confident-but-wrong mapping can ever starve a workstream of owner
 * authority. Literals already present are never duplicated. A trailer
 * that would push a goal past the canonical 2048 cap fails closed.
 */
export function appendMissingSourceTerms(
  children: Array<{ title: string; goal: string; depends_on_indices: number[] }>,
  sourceStatement: string,
): Array<{ title: string; goal: string; depends_on_indices: number[] }> {
  const literals = extractStatementLiterals(sourceStatement);
  if (literals.length === 0) return children;
  return children.map((child) => {
    const missing = literals.filter((l) => !child.goal.includes(l));
    if (missing.length === 0) return child;
    const trailer = `${TRAILER_PREFIX}${missing.join(" | ")}${TRAILER_SUFFIX}`;
    if (child.goal.length + trailer.length > CHILD_GOAL_CAP) {
      throw new IntegrityError(
        "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_PROPOSAL",
        `workstream goal + source terms exceeds ${CHILD_GOAL_CAP} cap`,
      );
    }
    return { ...child, goal: `${child.goal}${trailer}` };
  });
}
