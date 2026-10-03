# PAIR-NEXT — Incident DSN-1 Remediation Report
## Consume-name spelling normalization at the pre-dispatch prerequisite seam

**Branch:** `devin/1791275412-dsn1-consume-name-normalization`
**Base:** post-ACR-1 main (`20e78e9`)
**Classification:** `PAIR_NEXT_INCIDENT_DSN1_CONSUME_NAME_NORMALIZATION_PENDING_AUDIT`

---

## 1. Incident (evidence from prod `pair.db`)

Mission **`MSN_01M420PJ1E43FTZWB48ZBF8NV5`** — mini gold-dashboard — FAILED 2026-10-03T23:19:11Z:

- `T2` DEVIN produced `gold_prices.csv` → `ART_0DEEA…` ACCEPTED via the remote `acap1` lane.
- `T3` DEVIN produced `outbox/chart.png` → `ART_B84EA…` ACCEPTED.
- `T4` CODEX produced `report.md` → `ART_7E26E…` ACCEPTED.
- `T5` TELEGRAM_DELIVERY: provenance pins minted correctly for both FILES
  manifest artifacts (`pair_delivery_artifact_digests` → artifact_id +
  sha256 + producer_execution_id, state `PINNED`) — then the task failed
  **before dispatch**: recovery decision `RCV_01M4210XVTRH1W81XRP1EVV8JZ`
  carries `failure_context { artifact_name:"chart.png",
  dependency_reason:"LOCAL_PREREQUISITE_MISSING",
  source_code:"FAIL_CLOSED_LOCAL_PREREQUISITE_MISSING" }` → REPLAN attempt
  1 (same defect) → ABORT attempt 2 → mission FAILED.

## 2. Root cause — a name-spelling mismatch at one seam

The producer declared `produces:["outbox/chart.png"]`; the delivery task's
manifest/dataflow consumed `chart.png`. The canonical resolver already treats
`X` and its staged `outbox/<basename>` copy as one deliverable (the F4 alias
rule), so the provenance pin bound the correct artifact — but:

1. `resolveForConsumer` returns `[]` for delivery tasks **by design** (the
   handoff seam must not re-author a delivery path) → `canonicalResolved`
   at the dispatch arm was the empty set.
2. `prerequisiteMissing()` then compared consumes against that set by **raw
   string equality** — and since nothing matched, every consume was fed to
   the legacy `artifactPresentIn` workspace check.
3. The remote artifact's bytes live only in CAS (never written to the shared
   `outbox/`) → `chart.png` reported missing → fail-closed DEPENDENCY_FAILURE.

So the defect is two-fold and both halves are now fixed at the ONE seam:
the resolved set must include the delivery lane's canonical binding (the
pin), and "resolved" must be judged by the canonical spelling rule, never
by raw strings.

## 3. The fix

**`src/pair/artifact-authority.ts`** — one new exported rule next to
`normalizeArtifactName`:

- `artifactNamesEquivalent(a, b)` — the ONE spelling-equivalence rule:
  a name and its staged `outbox/<basename>` copy name the same deliverable.
  This is exactly the semantics the delivery resolver already used
  (`name` + `outbox/<basename>` candidates), lifted to a shared, symmetric
  predicate. Returns `false` for unnormalizable names, so a malformed
  consume/produce can never widen into a match.

**`src/pair/artifact-handoff.ts`** — both resolution seams now compare
through the shared rule:

- `resolveForConsumer`: producer matching is `declared-produce ≡ consume`
  instead of raw `Set.has` — so producer `outbox/X` binds consume `X`, and
  producer `X` binds consume `outbox/X` (both directions). Resolution then
  resolves *every* equivalent declared spelling and dedupes hits by
  `artifact_id`: equivalent spellings that bound **distinct** canonical
  artifacts throw `ambiguous_dependency_artifact` /
  `PLAN_DATAFLOW_AMBIGUOUS` — a consume can never pick lexically between
  two artifacts. No PASS anchor, identity, plan, or digest semantics moved.
- `resolveDeliveryArtifact`: the directional `candidates` set is replaced
  by the same equivalence predicate on both the producer filter and the
  hits loop. Semantics is a strict superset — every previously-accepted
  binding still binds; the mirror direction (manifest `outbox/X` ↔ produce
  `X`) now binds too; the R1.3 ambiguity closure is preserved verbatim.

**`src/pair/mission-runtime.ts`** — `prerequisiteMissing()`:

- The "resolved" name set is now `{ dependency_artifacts[].logical_name }`
  ∪ `{ pair_delivery_artifact_digests names + pinned logical_names whose
  entry carries artifact_id && state:"PINNED" }`. The pin is minted inside
  `requestFor` (before this check) and read back off the **durable** task
  row (`service.getTask`), so the in-memory snapshot staleness can't hide it.
  Only `PINNED` entries count — `TOO_LARGE`/absent entries grant nothing.
- Consumes are exempt iff an equivalent resolved name exists — via
  `artifactNamesEquivalent`, never raw compare. Unresolved consumes flow
  through the unchanged legacy `missingConsumedArtifact` path →
  `FAIL_CLOSED_LOCAL_PREREQUISITE_MISSING` exactly as before.
- Remote-consumer early return, self-produced skip, and workspace
  resolution are all untouched.

F4/F5 authority semantics preserved: pin minting, CAS provenance, the
delivery contract gate, declared_produces terminal closure — none moved.
No planner behavior change.

## 4. Tests — `src/__tests__/pair-dsn1-consume-name-normalization.test.ts` (9/9)

Each test drives the REAL dispatch-arm order: `requestFor` (pin + resolve)
→ `prerequisiteMissing` — plus the real resolver and the real handoff
materialization; remote producers ingest through the real `acap1`
capability lane.

| Test | Proves |
|------|--------|
| D1 | producer `outbox/data.json`, consumer `data.json` — alias binds the exact canonical artifact; prereq exempt; materialized bytes = CAS bytes |
| D2 | producer `data.json`, consumer `outbox/data.json` — mirror direction binds (previously `unbound_consume`) |
| D3 | declared produce but no canonical artifact → consume stays legacy → `a.txt` reported missing; providing the file clears it |
| D4 | remote canonical artifact with **empty shared outbox** → resolves, prereq null, bytes materialize under `.pair/dependency-artifacts`, nothing leaks into `outbox/` |
| D5 | consumes `[chart.png (resolved alias), scratch.txt (legacy)]` → only `scratch.txt` reported missing |
| D6 | **incident shape** — remote `outbox/chart.png` + delivery manifest `chart.png`: pin binds the artifact, prereq exempt via pin, `dependency_artifacts:[]` by design, shared outbox untouched |
| D7 | delivery manifest `outbox/report.txt` + producer `report.txt` — mirror direction on the delivery lane pins and exempts |
| D8 | one execution canonically accepting BOTH spellings (`chart.png` + `outbox/chart.png`) → `FAIL_CLOSED_DEPENDENCY_RESOLUTION` ambiguous on the dependency lane AND the delivery lane |
| D9 | stale same-name file `data.json` in the workspace alongside a resolved `outbox/data.json` binding → prereq null, materialized bytes are CAS bytes, contaminant untouched |

## 5. Validation

```
new suite:                 9/9   pass
F2 chain (5 files):        157/157
F4 + F5 + delivery:        190/190
F1 + F3 + incident (8 files): 318/318
npx tsc --noEmit:          0 errors
rm -rf dist && pnpm build: PASS
full suite:                3313 pass / 2 fail — only the 2 known env-only
                           P5 failures (DSH/CODEX executables present on
                           this box; unrelated to this change)
pnpm audit --audit-level=high: 0 high (9 moderate/low, unchanged)
```

## 6. Residual / non-goals

- Local→local consumes with **no** canonical artifact still use the legacy
  workspace-path check — by design (R2.1: only that lane keeps path
  semantics).
- A delivery consume that is *not* manifest-pinned and not canonically
  resolved still hits the legacy check — the pin only exempts what it
  actually bound.
- Planner prompt changes (declared-edge examples for small models) remain
  a separate pending candidate — DSN-1 changes no planner behavior.
