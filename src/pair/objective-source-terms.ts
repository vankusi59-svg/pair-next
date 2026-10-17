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
 * Determinism: extraction order = statement order; matching = pure
 * token overlap; a workstream with no confident clause match receives
 * the full statement literal set (wider, never wrong). Appending a
 * trailer that would push a goal past the canonical 2048 cap fails
 * closed — the commit never silently truncates owner authority.
 */

import { IntegrityError } from "./errors.js";

/** Same bound as `boundedStr(goal, 2048)` in objective-workstream.ts —
 *  trailers must live inside the canonical child-goal cap. */
const CHILD_GOAL_CAP = 2048;
/** One literal never exceeds 160 chars — a longer run is prose, not a
 *  source term. */
const LITERAL_CAP = 160;
/** A statement carrying more source terms than this is ambiguous by
 *  construction; the first N (statement order) are authoritative. */
const STATEMENT_LITERAL_CAP = 24;
/** Token-overlap floor for clause→workstream attribution. */
const CLAUSE_MATCH_MIN = 2;

const TRAILER_PREFIX = "\n\n[source terms: ";
const TRAILER_SUFFIX = "]";

/**
 * Literal families. Ordering inside the array is irrelevant — matches
 * are re-sorted by statement position — but each regex must be `g`.
 * POSIX/API paths use a lookbehind so `https://`, `a/b` fractions and
 * `and/or` prose never count as routes.
 */
const LITERAL_PATTERNS: RegExp[] = [
  /https?:\/\/[^\s"'<>()[\]{}]+/g,
  /\b[A-Za-z]:[\\/][^\s"'<>|]+/g,
  /(?<![\w:/])\/[\w][\w\-./]*/g,
  /\b\w[\w\-]*(?:\.\w[\w\-]*)*\.(?:html?|md|markdown|txt|json|csv|xml|ya?ml|toml|ini|cfg|log|mjs|cjs|jsx?|tsx?|py|ps1|sh|bat|css|png|jpe?g|gif|svg|pdf|zip|sql|db|rss)\b/gi,
  /(?<!\w)"[^"\n]{1,160}"(?!\w)|(?<!\w)'[^'\n]{1,160}'(?!\w)/g,
  /\b(?:local|session)Storage\s+key\s+(?:["'`][\w][\w.\-]*["'`]|[\w][\w.\-]*)/gi,
];

/**
 * Extract the statement's exact operational literals, deterministic:
 * statement-position order, deduplicated, substrings of already-kept
 * longer literals dropped (`mc-mini.html` inside `C:\…\mc-mini.html`),
 * each literal ≤160 chars, ≤24 literals total.
 */
export function extractStatementLiterals(statement: string): string[] {
  if (typeof statement !== "string" || !statement) return [];
  const hits: Array<{ index: number; text: string }> = [];
  for (const re of LITERAL_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(statement); m !== null; m = re.exec(statement)) {
      // Strip trailing clause punctuation a greedy path/URL match can
      // swallow (`C:\x,` → `C:\x`) — never quotes, they are literal data.
      const text = m[0].trim().replace(/[.,;:!?\)\]}>\\]+$/u, "");
      if (!text || text.length > LITERAL_CAP) continue;
      hits.push({ index: m.index, text });
    }
    if (hits.length > STATEMENT_LITERAL_CAP * 4) break; // scan bound
  }
  hits.sort((a, b) => a.index - b.index);
  const kept: string[] = [];
  for (const h of hits) {
    if (kept.includes(h.text)) continue;
    if (kept.some((k) => k.includes(h.text))) continue;
    if (kept.length >= STATEMENT_LITERAL_CAP) break;
    kept.push(h.text);
  }
  return kept;
}

/** Lowercase word tokens ≥3 chars — the overlap currency for matching.
 *  Dots/dashes/underscores split, so `weather.html` shares `weather`
 *  with a paraphrased goal. */
function tokenize(text: string): Set<string> {
  const s = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]{3,}/g)) {
    s.add(m[0]);
  }
  return s;
}

/**
 * Commit-time projection: return child specs whose goals carry the
 * statement literals they failed to preserve, as a `[source terms: …]`
 * trailer. A literal is attributed to a workstream when a statement
 * line containing it shares ≥CLAUSE_MATCH_MIN tokens with the
 * workstream's title+goal. A literal no workstream claims is an
 * uncertain mapping — it is appended to EVERY workstream (wider,
 * never wrong) rather than risk dropping owner authority.
 * Symmetrically, a workstream that claims nothing gets the full
 * literal set — a confident-but-wrong claim by a sibling must never
 * starve the workstream a literal was written for. Literals already
 * present verbatim are never duplicated. Overflow of the canonical
 * goal cap fails closed.
 */
export function appendMissingSourceTerms(
  children: Array<{ title: string; goal: string; depends_on_indices: number[] }>,
  sourceStatement: string,
): Array<{ title: string; goal: string; depends_on_indices: number[] }> {
  const literals = extractStatementLiterals(sourceStatement);
  if (literals.length === 0) return children;
  const clauses = sourceStatement
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const clauseTokens = clauses.map(tokenize);
  // clause index → literals the clause contains; score per workstream.
  const attached: Array<Set<string>> = children.map((child) => {
    const target = tokenize(`${child.title} ${child.goal}`);
    const mine = new Set<string>();
    clauses.forEach((c, i) => {
      const overlap = [...clauseTokens[i]!].filter((t) => target.has(t)).length;
      if (overlap < CLAUSE_MATCH_MIN) return;
      for (const l of literals) if (c.includes(l)) mine.add(l);
    });
    return mine;
  });
  const unclaimed = literals.filter((l) => !attached.some((s) => s.has(l)));
  return children.map((child, i) => {
    // A workstream that claims NOTHING is an uncertain mapping — it
    // receives the full literal set, never a confident-but-empty
    // attribution (that is exactly how a wrong-claiming sibling can
    // starve the workstream the literal belongs to).
    const candidates = attached[i]!.size > 0
      ? new Set([...attached[i]!, ...unclaimed])
      : new Set(literals);
    const missing = literals.filter((l) =>
      candidates.has(l) && !child.goal.includes(l));
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
