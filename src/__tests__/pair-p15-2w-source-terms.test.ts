/**
 * P15.2W — source-term preservation for delegated workstream goals.
 *
 * Mandate: literals the CEO LLM paraphrases out of workstream goals
 * (URLs, Windows paths, API routes, filenames, quoted keys, storage
 * keys) must be restored deterministically from the canonical
 * Objective statement before P14 children commit — as a bounded
 * `[source terms: …]` trailer that never touches the normalized
 * proposal digest.
 *
 *   A extraction — families, ordering, dedupe, caps, prose safety
 *   B projection — clause matching, fallback, no-dup, cap fail-closed
 *   C end-to-end — decomposeObjective commits enriched child goals;
 *     replay converges; "same as X" references survive verbatim
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  BusinessLayer,
  IntegrityError,
  ObjectiveAuthorityService,
  ObjectiveWorkstreamService,
  PairEvidenceStore,
  WorkforceAllocationService,
  WorkforceService,
  appendMissingSourceTerms,
  decompositionProposal,
  decompositionProposalDigest,
  decompositionRowId,
  digest,
  extractStatementLiterals,
  normalizeObjectiveWorkstreamProposal,
} from "../pair/index.js";

const ROOT = mkTmpDir("pair-p152w-");
let counter = 0;

function freshStack(name: string) {
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const biz = new BusinessLayer({
    store,
    control: { projects: () => [{ project_id: "PRJ_TEST" }] } as never,
    schedules: {} as never,
  });
  const wf = new WorkforceService({ store, business: biz });
  const objectives = biz.objectives;
  const svc = new ObjectiveWorkstreamService({ store, business: biz, workforce: wf, objectives });
  return { store, biz, objectives, svc };
}

const OP = "1882810918";

function mkBusiness(store: PairEvidenceStore, id = `BIZ_${digest(String(counter)).slice(0, 8)}_${counter}`) {
  store.put("business", id, {
    business_id: id, name: "b", status: "ACTIVE", currency: "USD",
    project_id: "PRJ_TEST", created_at: "x", version: 0,
  }, 0);
  return id;
}

function mkObjective(
  svc: ObjectiveAuthorityService,
  businessId: string,
  statement: string,
) {
  return svc.create({
    business_id: businessId,
    title: "t",
    statement,
    kpis: [{ name: "k", unit: "u", baseline: 0, target: 1 }],
    deadline: "2999-01-01T00:00:00.000Z",
    budget_ceiling_microusd: 500_000_000,
    hard_constraints: ["hc"],
    success_conditions: ["sc"],
    operator_id: OP,
  });
}

function rowCount(store: PairEvidenceStore, entity: string): number {
  return store.list(entity).length;
}

function pins(o: Record<string, unknown>) {
  return {
    expected_objective_version: Number(o.version),
    expected_terms_version: Number(o.terms_version),
    expected_objective_digest: String(o.objective_digest),
  };
}

const BRIEFING_STATEMENT = [
  "Produce a morning briefing page as briefing.html (self-contained, no CDN).",
  "Weather data must come from https://wttr.in/Hanoi?format=j1 .",
  "FX data must come from https://open.er-api.com/v6/latest/USD .",
  "News must come from https://vnexpress.net/rss/tin-moi-nhat.rss and show five items.",
  "Persist last refresh in localStorage key \"brief.last\".",
].join("\n");

/* ============================ A — extraction ============================ */

describe("P15.2W A — literal extraction", () => {
  it("extracts every literal family in statement order", () => {
    const lits = extractStatementLiterals(
      "Use https://a.example/x and C:\\data\\in.csv, hit /api/health, " +
      "write out.txt, persist localStorage key \"k1\" and flag 'on' .");
    expect(lits).toEqual([
      "https://a.example/x",
      "C:\\data\\in.csv",
      "/api/health",
      "out.txt",
      "localStorage key \"k1\"",
      "'on'",
    ]);
  });

  it("prose fractions and apostrophes are never literals", () => {
    const lits = extractStatementLiterals(
      "Read csv/json files; don't guess and/or assume it's fine, y'know.");
    expect(lits).not.toContain("/or");
    expect(lits).not.toContain("/json");
    for (const l of lits) expect(l.startsWith("'")).toBe(false);
  });

  it("URL members are not double-extracted as routes", () => {
    const lits = extractStatementLiterals(
      "Fetch https://open.er-api.com/v6/latest/USD and store it.");
    expect(lits).toEqual(["https://open.er-api.com/v6/latest/USD"]);
  });

  it("a filename inside a longer path literal is dropped, standalone kept", () => {
    const lits = extractStatementLiterals(
      "Read the token from C:\\Users\\Admin\\pair-mc-token and write report.txt .");
    expect(lits).toContain("C:\\Users\\Admin\\pair-mc-token");
    expect(lits).toContain("report.txt");
    expect(lits).not.toContain("pair-mc-token");
  });

  it("empty or literal-free statements extract nothing", () => {
    expect(extractStatementLiterals("")).toEqual([]);
    expect(extractStatementLiterals("Grow sales through better marketing.")).toEqual([]);
  });

  // R2-F2 — URL/endpoint corruption: legal URL characters must survive.
  it("preserves parentheses, brackets and query strings verbatim", () => {
    expect(extractStatementLiterals(
      "See https://en.wikipedia.org/wiki/Function_(mathematics) for details."))
      .toEqual(["https://en.wikipedia.org/wiki/Function_(mathematics)"]);
    expect(extractStatementLiterals(
      "GET https://api.example/items?ids[]=1 then stop."))
      .toEqual(["https://api.example/items?ids[]=1"]);
    expect(extractStatementLiterals(
      "Call /api/weather?city=Hanoi&units=metric now."))
      .toEqual(["/api/weather?city=Hanoi&units=metric"]);
  });

  it("strips prose punctuation the literal never owned", () => {
    // trailing ')' closes the prose paren, not the URL
    expect(extractStatementLiterals("(see https://x.example/a)"))
      .toEqual(["https://x.example/a"]);
    // sentence-end period, comma, colon are not literal data
    expect(extractStatementLiterals("fetch https://x.example/a, then /api/v1."))
      .toEqual(["https://x.example/a", "/api/v1"]);
  });
});

/* ============================ B — projection ============================ */

const child = (title: string, goal: string) => ({ title, goal, depends_on_indices: [] });

describe("P15.2W B — trailer projection", () => {
  it("every workstream receives every missing literal (preservation broadcast)", () => {
    // R2-F1 — token-overlap attribution was abandoned: no heuristic can
    // prove which workstream owns a literal, so preservation beats
    // attribution precision. Both goals get both sources.
    const statement = [
      "Deliverable 1 — NEW file weather.html using https://wttr.in/Hanoi?format=j1 .",
      "Deliverable 2 — NEW file news.html using https://vnexpress.net/rss/tin-moi-nhat.rss .",
    ].join("\n");
    const out = appendMissingSourceTerms(
      [child("Weather page", "Build the weather deliverable page"),
       child("News page", "Build the news deliverable page")],
      statement);
    for (const ws of out) {
      expect(ws.goal).toContain("https://wttr.in/Hanoi?format=j1");
      expect(ws.goal).toContain("https://vnexpress.net/rss/tin-moi-nhat.rss");
      expect(ws.goal).toContain("[source terms:");
    }
  });

  it("R2-F1 repro — partial claim cannot starve the real literal", () => {
    // The weather workstream claims dashboard.css via overlap yet must
    // still receive the weather URL it actually needs.
    const statement = [
      "Deliverable 1 — NEW file weather.html using https://wttr.in/Hanoi?format=j1 .",
      "Deliverable 2 — NEW file dashboard.css using https://assets.example/app.css .",
    ].join("\n");
    const out = appendMissingSourceTerms(
      [child("Weather widget", "Build weather widget with dashboard.css styling")],
      statement);
    expect(out[0]!.goal).toContain("https://wttr.in/Hanoi?format=j1");
    expect(out[0]!.goal).not.toContain("dashboard.css |"); // already verbatim
    expect(out[0]!.goal).toContain("https://assets.example/app.css");
  });

  it("unmatched workstream falls back to the full literal set", () => {
    const out = appendMissingSourceTerms(
      [child("Aggregate", "Combine the three feeds into one page")],
      BRIEFING_STATEMENT);
    for (const l of extractStatementLiterals(BRIEFING_STATEMENT)) {
      expect(out[0]!.goal).toContain(l);
    }
  });

  it("literals already verbatim in the goal are never duplicated", () => {
    const statement = "Use https://a.example/x and https://b.example/y .";
    const out = appendMissingSourceTerms(
      [child("Page", "fetch https://a.example/x please")], statement);
    expect(out[0]!.goal.match(/a\.example/g)!.length).toBe(1);
    expect(out[0]!.goal).toContain("https://b.example/y");
  });

  it("a fully-literal goal gains no trailer", () => {
    const statement = "Write report.txt only.";
    const out = appendMissingSourceTerms(
      [child("R", "Write report.txt only.")], statement);
    expect(out[0]!.goal).toBe("Write report.txt only.");
  });

  it("trailer overflow fails closed — never silently truncates", () => {
    const statement = "Fetch https://a.example/very/long/source for data.";
    const big = child("Big", "g".repeat(2000));
    try {
      appendMissingSourceTerms([big], statement);
      throw new Error("unreachable");
    } catch (e) {
      expect(e).toBeInstanceOf(IntegrityError);
      expect((e as { code?: string }).code)
        .toBe("FAIL_CLOSED_OBJECTIVE_WORKSTREAM_PROPOSAL");
    }
  });

  it("literal-free statements leave children untouched", () => {
    const kids = [child("A", "do a"), child("B", "do b")];
    expect(appendMissingSourceTerms(kids, "grow sales")).toBe(kids);
  });
});

/* ============================ C — end-to-end ============================ */

describe("P15.2W C — decomposeObjective commits enriched goals", () => {
  it("three statement URLs survive verbatim into committed children", () => {
    const { store, objectives, svc } = freshStack("c-briefing");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid, BRIEFING_STATEMENT);
    const res = svc.decomposeObjective({
      objective_id: String(o.objective_id),
      ...pins(o),
      workstreams: [
        { workstream_key: "build", title: "Build briefing page",
          goal: "fetch the specified weather, FX and RSS feeds", depends_on_keys: [] },
      ],
      actor: OP,
    });
    const goal = String(res.children[0]!.goal);
    expect(goal).toContain("https://wttr.in/Hanoi?format=j1");
    expect(goal).toContain("https://open.er-api.com/v6/latest/USD");
    expect(goal).toContain("https://vnexpress.net/rss/tin-moi-nhat.rss");
    expect(goal).toContain("localStorage key \"brief.last\"");
    expect(goal).toContain("[source terms:");
  });

  it("'same as X' references keep the referenced filename verbatim", () => {
    const { store, objectives, svc } = freshStack("c-sameas");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid,
      "Deliverable 1 — NEW file invoice.html: self-contained invoice generator.\n" +
      "Deliverable 2 — quote.html with the same capabilities as invoice.html.");
    const res = svc.decomposeObjective({
      objective_id: String(o.objective_id),
      ...pins(o),
      workstreams: [
        { workstream_key: "inv", title: "Invoice generator",
          goal: "Create NEW invoice.html as a self-contained invoice generator", depends_on_keys: [] },
        { workstream_key: "quote", title: "Quote generator",
          goal: "Create NEW quote.html with the same capabilities", depends_on_keys: ["inv"] },
      ],
      actor: OP,
    });
    const quote = res.children.find((c) => String(c.title).includes("Quote"))!;
    expect(String(quote.goal)).toContain("quote.html");
    expect(String(quote.goal)).toContain("invoice.html");
  });

  it("replay converges — trailer never enters the proposal digest", () => {
    const { store, objectives, svc } = freshStack("c-replay");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid, BRIEFING_STATEMENT);
    const input = {
      objective_id: String(o.objective_id),
      ...pins(o),
      workstreams: [
        { workstream_key: "build", title: "Build",
          goal: "fetch the specified feeds", depends_on_keys: [] },
      ],
      actor: OP,
    };
    const first = svc.decomposeObjective(input);
    const again = svc.decomposeObjective(input); // identical proposal
    expect(String(again.binding.binding_digest))
      .toBe(String(first.binding.binding_digest));
    expect(String(again.children[0]!.goal))
      .toBe(String(first.children[0]!.goal));
    // A different proposal on the same objective still conflicts.
    try {
      svc.decomposeObjective({
        ...input,
        workstreams: [
          { workstream_key: "other", title: "O", goal: "different", depends_on_keys: [] },
        ],
      });
      throw new Error("unreachable");
    } catch (e) {
      expect((e as { code?: string }).code)
        .toBe("FAIL_CLOSED_OBJECTIVE_WORKSTREAM_CONFLICT");
    }
  });
});

/* ============ D — F1/F2/F3 audit-prep regressions ============ */

describe("P15.2W F1 — confident-but-wrong claim cannot starve a sibling", () => {
  it("a workstream claiming nothing receives the full literal set", () => {
    const statement = [
      "Deliverable 1 — NEW file weather.html using https://wttr.in/Hanoi?format=j1 .",
      "Deliverable 2 — NEW file news.html using https://vnexpress.net/rss/tin-moi-nhat.rss .",
    ].join("\n");
    const out = appendMissingSourceTerms([
      // Shares only {weather}=1 token with clause 1 — needs the URL
      // but claims nothing under the >=2 threshold.
      child("Weather widget", "Build the weather widget"),
      // Claims both clauses via generic tokens {deliverable, file}=2 —
      // without the empty-claim fallback it would starve ws[0].
      child("Ops console", "Manage deliverable file operations"),
    ], statement);
    expect(out[0]!.goal).toContain("https://wttr.in/Hanoi?format=j1");
    expect(out[0]!.goal).toContain("https://vnexpress.net/rss/tin-moi-nhat.rss");
    expect(out[1]!.goal).toContain("https://wttr.in/Hanoi?format=j1");
  });
});

describe("P15.2W F2 — digest, replay and amend integrity", () => {
  it("binding digest pins the RAW proposal; WDEC digest covers the ENRICHED goal", () => {
    const { store, objectives, svc } = freshStack("f2-digest");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid, BRIEFING_STATEMENT);
    const input = {
      objective_id: String(o.objective_id),
      ...pins(o),
      workstreams: [
        { workstream_key: "build", title: "Build",
          goal: "fetch the specified feeds", depends_on_keys: [] },
      ],
      actor: OP,
    };
    const res = svc.decomposeObjective(input);
    // Cross-layer binding digest == digest of the raw proposal — the
    // trailer never enters normalized_proposal_digest.
    const raw = normalizeObjectiveWorkstreamProposal({
      objective_id: input.objective_id, workstreams: input.workstreams });
    expect(String(res.binding.normalized_proposal_digest))
      .toBe(raw.normalizedProposalDigest);
    expect(String(res.children[0]!.goal)).toContain("[source terms:");
    // P14 WDEC proposal digest covers the ENRICHED committed goal —
    // recompute the canonical proposal over the stored spec.
    const rootId = String(res.root.work_item_id);
    const wdec = store.get("work_decomposition", decompositionRowId(rootId));
    const c = res.children[0]!;
    const spec = [{
      work_item_id: String(c.work_item_id),
      title: String(c.title),
      goal: String(c.goal),
      assignee_agent_id: c.assignee_agent_id ?? null,
      requires_review: c.requires_review === true,
      required_capability: c.required_capability ?? null,
      depends_on: [] as string[],
    }];
    expect(decompositionProposalDigest(decompositionProposal(
      rootId, String(wdec.decomposition_id), bid, spec, null, null)))
      .toBe(String(wdec.proposal_digest));
    // Mutating the goal changes the digest — the coverage is real.
    spec[0]!.goal = "tampered goal without the trailer";
    expect(decompositionProposalDigest(decompositionProposal(
      rootId, String(wdec.decomposition_id), bid, spec, null, null)))
      .not.toBe(String(wdec.proposal_digest));
  });

  it("post-commit objective amendment cannot alter the committed graph", () => {
    const { store, objectives, svc } = freshStack("f2-amend");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid, BRIEFING_STATEMENT);
    const input = {
      objective_id: String(o.objective_id),
      ...pins(o),
      workstreams: [
        { workstream_key: "build", title: "Build",
          goal: "fetch the specified feeds", depends_on_keys: [] },
      ],
      actor: OP,
    };
    const res = svc.decomposeObjective(input);
    const committedGoal = String(res.children[0]!.goal);
    // Amend the statement — a NEW literal appears after commit.
    objectives.amend(String(o.objective_id), {
      business_id: bid,
      patch: { statement: `${BRIEFING_STATEMENT}\nAlso fetch https://late.example/feed .` },
      reason: "r",
      actor: `operator:${OP}`,
    });
    // Replaying the identical proposal converges on stored rows — the
    // new statement literal is NOT retro-injected into committed goals.
    const replay = svc.decomposeObjective(input);
    expect(String(replay.children[0]!.goal)).toBe(committedGoal);
    expect(String(replay.children[0]!.goal)).not.toContain("late.example");
  });
});

describe("P15.2W F3 — bounds, odd literals and DL propagation", () => {
  it("extraction bounds fail closed — no silent literal truncation", () => {
    // >24 unique literals: preservation impossible → typed error, never
    // a silently shortened set reported as success.
    const urls = Array.from({ length: 30 }, (_, i) => `https://s${i}.example/f`);
    try {
      extractStatementLiterals(urls.join(" and "));
      throw new Error("unreachable");
    } catch (e) {
      expect((e as { code?: string }).code)
        .toBe("FAIL_CLOSED_OBJECTIVE_WORKSTREAM_LITERALS");
    }
    // a matched literal exceeding the 160-char bound likewise fails.
    try {
      extractStatementLiterals(`fetch https://${"y".repeat(200)}`);
      throw new Error("unreachable");
    } catch (e) {
      expect((e as { code?: string }).code)
        .toBe("FAIL_CLOSED_OBJECTIVE_WORKSTREAM_LITERALS");
    }
    // at the bound everything still works.
    expect(extractStatementLiterals(
      Array.from({ length: 24 }, (_, i) => `https://s${i}.example/f`).join(" ")
    ).length).toBe(24);
  });

  it("extraction-bound failure rolls back the whole commit atomically", () => {
    const { store, objectives, svc } = freshStack("f3-extract-bound");
    const bid = mkBusiness(store);
    const urls = Array.from({ length: 30 }, (_, i) => `https://s${i}.example/f`);
    const o = mkObjective(objectives, bid, urls.join("\n"));
    const before = rowCount(store, "work_item") + rowCount(store, "work_decomposition");
    try {
      svc.decomposeObjective({
        objective_id: String(o.objective_id),
        ...pins(o),
        workstreams: [
          { workstream_key: "w", title: "w", goal: "do it", depends_on_keys: [] },
        ],
        actor: OP,
      });
      throw new Error("unreachable");
    } catch (e) {
      expect((e as { code?: string }).code)
        .toBe("FAIL_CLOSED_OBJECTIVE_WORKSTREAM_LITERALS");
    }
    expect(rowCount(store, "work_item") + rowCount(store, "work_decomposition"))
      .toBe(before);
    expect(svc.getBinding(String(o.objective_id))).toBeNull();
  });

  it("goal+trailer overflow fails closed with zero graph residue", () => {
    const { store, objectives, svc } = freshStack("f3-overflow");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid,
      "Fetch https://a.example/source for the report.");
    const before = rowCount(store, "work_item") + rowCount(store, "work_decomposition");
    try {
      svc.decomposeObjective({
        objective_id: String(o.objective_id),
        ...pins(o),
        workstreams: [
          { workstream_key: "w", title: "w",
            goal: "g".repeat(2020), depends_on_keys: [] },
        ],
        actor: OP,
      });
      throw new Error("unreachable");
    } catch (e) {
      expect((e as { code?: string }).code)
        .toBe("FAIL_CLOSED_OBJECTIVE_WORKSTREAM_PROPOSAL");
    }
    // Atomic rollback — no root, no children, no WDEC, no binding.
    expect(rowCount(store, "work_item") + rowCount(store, "work_decomposition"))
      .toBe(before);
    expect(svc.getBinding(String(o.objective_id))).toBeNull();
  });

  it("literals containing | or ] survive verbatim; newlines never enter", () => {
    const statement = 'flag "a|b]c" controls mode';
    const lits = extractStatementLiterals(statement);
    expect(lits).toContain('"a|b]c"');
    const out = appendMissingSourceTerms(
      [child("Mode", "set the mode")], statement);
    expect(out[0]!.goal).toContain('"a|b]c"');
    for (const l of extractStatementLiterals('x "one\ntwo" y')) {
      expect(l).not.toContain("\n");
    }
  });

  it("enriched goal propagates verbatim DC -> DL delegated child", () => {
    const { store, biz, objectives, svc } = freshStack("f3-dl");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid, BRIEFING_STATEMENT);
    const oid = String(o.objective_id);
    const res = svc.decomposeObjective({
      objective_id: oid,
      ...pins(o),
      workstreams: [
        { workstream_key: "build", title: "Build",
          goal: "fetch the specified feeds", depends_on_keys: [] },
      ],
      actor: OP,
    });
    const alloc = new WorkforceAllocationService({
      store,
      business: biz,
      workforce: new WorkforceService({ store, business: biz }),
      objectives,
      workstreams: svc,
    });
    biz.createOrgAgent({
      business_id: bid, title: "agent", department: "ops", operator_id: OP,
    });
    const r = alloc.allocateWorkstream({ objective_id: oid, workstream_key: "build", actor: OP });
    expect(r.status).toBe("allocated");
    const dl = store.get("work_item", String(r.delegated_child_work_item_id));
    expect(String(dl.goal)).toBe(String(res.children[0]!.goal));
    expect(String(dl.goal)).toContain("https://wttr.in/Hanoi?format=j1");
    expect(String(dl.goal)).toContain("[source terms:");
    expect(String(dl.goal).match(/\[source terms:/g)!.length).toBe(1);
  });
});

/* ============ E — R3 audit regressions ============ */

describe("P15.2W R3 — audit corrections", () => {
  // R3-F1 — '+' and '=' at a URL tail can be real query data (base64
  // signatures end in '+'/'='; empty-valued params end in '=').
  // stripLiteralTail must not default-strip them.
  it("R3-F1 — trailing '+' inside a URL query value is literal data", () => {
    expect(extractStatementLiterals(
      "Sign with https://api.example/token?signature=abc+ and call."))
      .toEqual(["https://api.example/token?signature=abc+"]);
  });

  it("R3-F1 — trailing '=' inside a URL query value is literal data", () => {
    expect(extractStatementLiterals(
      "Search via https://api.example/search?q= next."))
      .toEqual(["https://api.example/search?q="]);
  });

  // R3-F2 — the quoted-literal pattern is bounded at {1,160}, so a
  // longer quoted run never matches and is silently ignored instead of
  // reaching the LITERAL_CAP fail-closed check.
  it("R3-F2 — oversized double-quoted literal fails closed, never ignored", () => {
    const lit = `"${"x".repeat(161)}"`;
    try {
      extractStatementLiterals(`persist key ${lit} now`);
      throw new Error("unreachable");
    } catch (e) {
      expect((e as { code?: string }).code)
        .toBe("FAIL_CLOSED_OBJECTIVE_WORKSTREAM_LITERALS");
    }
  });

  it("R3-F2 — oversized single-quoted literal fails closed, rollback clean", () => {
    const lit = `'${"y".repeat(190)}'`;
    try {
      extractStatementLiterals(`use flag ${lit} here`);
      throw new Error("unreachable");
    } catch (e) {
      expect((e as { code?: string }).code)
        .toBe("FAIL_CLOSED_OBJECTIVE_WORKSTREAM_LITERALS");
    }
    // The same statement must abort decomposeObjective inside the
    // atomic transaction — no root, children, WDEC or binding residue.
    const { store, objectives, svc } = freshStack("r3-quoted-oversize");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid, `use flag ${lit} here`);
    const before = rowCount(store, "work_item") + rowCount(store, "work_decomposition");
    try {
      svc.decomposeObjective({
        objective_id: String(o.objective_id),
        ...pins(o),
        workstreams: [
          { workstream_key: "w", title: "w", goal: "do it", depends_on_keys: [] },
        ],
        actor: OP,
      });
      throw new Error("unreachable");
    } catch (e) {
      expect((e as { code?: string }).code)
        .toBe("FAIL_CLOSED_OBJECTIVE_WORKSTREAM_LITERALS");
    }
    expect(rowCount(store, "work_item") + rowCount(store, "work_decomposition"))
      .toBe(before);
    expect(svc.getBinding(String(o.objective_id))).toBeNull();
  });
});
