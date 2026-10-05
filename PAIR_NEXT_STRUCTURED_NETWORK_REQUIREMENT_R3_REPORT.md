# STRUCTURED NETWORK REQUIREMENT — R3 Remediation Report

**Status:** `PAIR_NEXT_STRUCTURED_NETWORK_REQUIREMENT_R3_PENDING_AUDIT`
**PR:** [#51](https://github.com/vankusi59-svg/pair-next/pull/51) — OPEN, NOT MERGED (operator merges after independent audit)
**Audited base:** R2 HEAD `c83f6e5` (verified: `git log` on branch `devin/1791196681-netreq-struct` — ancestor chain `c83f6e5 ← 93ebb82 ← d635d62`)
**R3 scope:** close the ONE authorization flaw the R2 audit found — entity/label-based host authorization. Only this flaw; no planner redesign, no PRV2-B, no live mission test.

---

## 1. Root cause

Under R2, operator-side authorization was `extractGoalIdentities(goal)` + `goalAuthorizesHost(host, identities)`:

- `extractGoalIdentities` collected (1) hosts + (2) **proper-noun-shaped tokens**: any word containing a digit (`144`, `MQL5`), a camelCase capital (`OpenAI`), or ≥2 ALL-CAPS letters (`GPT`, `BTC`, `EA`).
- `goalAuthorizesHost` then authorized a host if `labels.includes(identity)` — **any DNS label** of the locator host equal to any goal token.

Consequences demonstrated by the R2 audit:
- Goal "compute sqrt(144)" → token `144` became an identity → `144.attacker.example` authorized.
- Goal "Research MQL5" → token `mql5` → `mql5.attacker.example` authorized (proper-noun bypass).
- Goal "save to math.txt" → dotted file token `math.txt` became a host identity → a locator `math.txt` authorized.
- `mql5.com.attacker.example` authorized because label `mql5`/`com` matched goal tokens.

An entity name is a **semantic noun**, not a hostname authorization — that equivalence is the whole flaw.

## 2. What R3 changed — exact files

| File | Change |
|---|---|
| `src/pair/network-requirement.ts` | `extractGoalIdentities` **deleted** (only authority use was the two seams below). `extractGoalHosts` bare-token path now uses `BARE_DOTTED_RE` (strict DNS labels) + `bareTokenHost()` (filename-extension deny, IP-shape deny, `www.` normalization). `goalAuthorizesHost` rewritten to exact-match-or-label-boundary-subdomain ONLY. `resolveTaskNetworkAuthority` arg renamed `goalIdentities → goalHosts`. Header comment gains the R3 paragraph. |
| `src/pair/llm-planner.ts` | import + call site switched to `extractGoalHosts`; repair docstring rewritten to R3 conditions. |
| `src/pair/serve-planner.ts` | same import/call-site switch at the canonicalizer seam. |
| `src/__tests__/pair-network-requirement-r3.test.ts` | NEW — adversarial R3.A–R3.K (11 tests, production-path on both transports). |
| `src/__tests__/pair-network-requirement.test.ts` | imports/calls renamed; header notes R3; one added subdomain-gate assertion pair. |
| `src/__tests__/pair-network-binding-repair.test.ts` | `GOAL_NET` now literally names `mql5.com` (required for authorized repair under R3); comments updated. |
| `src/__tests__/pair-prv2b-goal-coverage.test.ts` | goals carrying NETWORK tasks literally name `mql5.com`; fixture comment updated. |
| `src/__tests__/pair-prv2a-planner-modernization.test.ts` | test-11 goal names `api.btc.example` so its locator is operator-authorized; comment updated. |
| `PAIR_NEXT_STRUCTURED_NETWORK_REQUIREMENT_R3_REPORT.md` | this file |
| `CURRENT_STATE.md` | R3 entry appended |

## 3. Identity/label authority — removed completely

`extractGoalIdentities` had **no non-authority consumer** (repair seam + canonicalizer gate + tests only) → deleted per mandate. Nothing replaces it: no proper-noun/ALL-CAPS/camelCase/digit tokens, no `labels.includes` matching, no entity→domain maps, no stopwords, no keyword vocabularies, no DNS/search queries. `git grep` for `extractGoalIdentities|goalIdentities` now matches only this report, the R3 test comment, CURRENT_STATE history, and the R2 report (historical record).

## 4. Final explicit-host authorization rule (the ONLY surface)

`goalAuthorizesHost(host, goalHosts)`:

```ts
h = stripWww(host.toLowerCase());
for (const g of goalHosts) if (h === g || h.endsWith(`.${g}`)) return true;
return false;
```

- goal `mql5.com` → allows `mql5.com`, `www.mql5.com` (normalized), `api.mql5.com`.
- `endsWith(".")` + boundary dot ⇒ label-boundary subdomain matching — no sibling/suffix tricks.
- goal `api.mql5.com` → allows `api.mql5.com` + `x.api.mql5.com` only; **no parent/sibling widening** (the reverse-containment branch `g.endsWith("."+host)` from R2 is removed — least authority).
- goal "Research MQL5" (names no host) → `mql5.com` **denied too** — intentional fail-closed.

Authorization matrix (unit-proven): `mql5.com`/`www.`/`api.mql5.com` ✓; `mql5.attacker.example`, `foo.mql5.example`, `mql5.com.attacker.example`, `evil-mql5.com`, `attacker-mql5.com`, `mql5com.example`, `mql5.com.evil.org` ✗.

## 5. Filename-vs-host disambiguation (fail-closed choice)

A bare dotted token is ambiguous: `mql5.com` and `math.txt` are the same shape. Mandate forbids a TLD *allowlist* and requires ambiguity to resolve fail-closed. Implementation:

- `scheme://` URL → unambiguous operator evidence, `new URL` parse (unchanged).
- Bare token → must satisfy strict DNS labels (`[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`), ≥2 labels, **final label contains a letter** (kills `1.2`, `192.168.1.1`), and **final label ∉ `FILE_EXTENSION_LABELS`** — a bounded **filename-extension denylist** (~90 entries incl. `txt/md/json/csv/mq4/mq5/ex4/ex5/zip/pdf…`), direction = deny ⇒ fail-closed.
- `www.` is stripped after extraction; the remainder must still contain a dot.
- Path-joined forms (`outbox/report.txt`, `./config.json`, `reports/data.csv`) are blocked at the regex lookbehind (preceding `/`/`.` disqualifies the token) **and** at the extension check — belt and suspenders.
- Residual disclosed: an invented filename extension not in the denylist (`report.xyzq`) still resolves as a host when the goal literally writes it — bounded, deliberate, and fail-closed in direction (denylist grows ⇒ denial grows).

## 6. Forged-identity proof (production path, both transports)

R3.A (llmPlan sanitize → repair → `makeServeCanonicalizer`, and `codexPlannerPlan` parity):
- goal "Tính căn bậc hai của 144 và lưu kết quả vào math.txt." → `extractGoalHosts` returns **∅** (144 is not dotted; `math.txt` denied by extension).
- planner emits `EXTERNAL_SITE/RESEARCH/REQUIRED` + locator `https://144.attacker.example` → repair adds **nothing** (no `REPAIRED_NETWORK_CAPABILITY`), canonicalizer throws `FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID {UNAUTHORIZED_SOURCE}` on both transports.

R3.B: goal "Research MQL5" (proper noun, no hostname) → `mql5.attacker.example` AND `mql5.com` both `UNAUTHORIZED_SOURCE`, zero repair.

R3.G: `NETWORK_ACCESS` forged in `required_capabilities` beside an unauthorized source → same typed rejection (the cap cannot self-authorize).

## 7. MQL5.com positive/negative matrix (R3.C/D)

| Goal names | Locator | Verdict |
|---|---|---|
| `MQL5.com` | `mql5.com`, `www.mql5.com`, `api.mql5.com` | REQUIRED authorized ✓ (production path repairs + canonicalizes clean) |
| `MQL5.com` | `mql5.attacker.example`, `foo.mql5.example`, `mql5.com.attacker.example`, `evil-mql5.com`, `attacker-mql5.com`, `mql5com.example`, `mql5.com.evil.org` | INVALID `UNAUTHORIZED_SOURCE` ✗ |
| `api.mql5.com` | `api.mql5.com`, `x.api.mql5.com` | authorized ✓ |
| `api.mql5.com` | `mql5.com`, `www.mql5.com`, `other.mql5.com` | denied — no widening ✗ |
| (none) | any external host | denied — fail closed ✗ |

## 8. Arbitrary-TLD proof (R3.F — no TLD enumeration)

`data.portal.example123` and `node-7.zzzqq` — suffixes no TLD list could contain — authorize when the goal literally writes them, and authorize subdomains (`api.data.portal.example123`) while denying unrelated parents. Authorization is syntax-only.

## 9. Unified verdict & R2 semantics — unchanged (R3.H/I/J)

`resolveTaskNetworkAuthority` is still the ONE verdict consumed by both seams — authorization logic is not duplicated. Only the argument carries hosts instead of identities.

- **R3.H**: authorized host + missing cap → `REPAIRED_NETWORK_CAPABILITY:T2`; unauthorized → zero repair, task untouched.
- **R3.I** (fresh regression): missing → `REQUIREMENT_MISSING`, malformed → `REQUIREMENT_MALFORMED` (digest-covered marker from sanitize), conflict top-level↔metadata → `REQUIREMENT_CONFLICT`. All typed, all re-ask/failover — never detector fallback.
- **R3.J** (persisted legacy): `ctx.provenance:"persisted"` → LEGACY verdict → vocabulary detectors still decide; identical bytes under `fresh` → `REQUIREMENT_MISSING`. Legacy is never inferred from field absence — call-site provenance only.
- **R3.K** (digest/replay): no new mutable authority field was introduced — `network_requirement` remains the sole network-authority input and stays digest-covered (mutating it changes `canonicalPlanSemanticDigest`). Goal hosts derive from the operator goal text itself — already mission-input authority.

## 10. Validation evidence

| Check | Result |
|---|---|
| R3 adversarial suite A–K | 11/11 |
| focused network suites (`network-requirement`, `network-requirement-r3`, `network-binding-repair`) | 36/36 |
| planner focused suites (llm-planner, cpl1 codex, prv2a, prv2b, pgrammar2, preask-feedback reask, covmap, plan-feasibility, dataflow incident, phase-b, p13) | all pass (prv2b needed the GOAL_ONLY/GOAL_ONLY2 host moved to a separate clause — OBL text is coverage-anchored; verified via `extractGoalContract` that `see mql5.com` mints nothing) |
| `npx tsc --noEmit` | clean |
| `rm -rf dist && pnpm build` | clean |
| **full suite** | **3669 pass / 3 fail** — identical to baseline failure set (2× `pair-p5` env-only probe expectations + `pair-f4` `R5.1-crash`); count delta = new/migrated tests (+20 net) |

## 11. Remaining risks / explicit non-goals

- **Verbatim MQL5 operator goal still EXHAUSTs at Bug A** (PRV2-B `prohibitionTerms` treats goal-mandated tokens as forbidden — `CONSTRAINT_VIOLATION`). Out of R3 scope per mandate; needs its own structured-constraint mandate.
- **Filename-extension denylist residual** (§5): unlisted invented extensions still parse as hosts when literally named by the operator — the disambiguation is bounded-fail-closed by design; an operator writing `see report.xyzq` in a goal is making explicit evidence, which is within the trust contract.
- Host authorization is a *locator* check: it does not confer delivery/artifact/FILE authority — those seams unchanged.
- **LIVE MISSION TEST NOT RUN — operator will test manually.**
- Env note (separate operational incident, unchanged): `~/.pair-dsh-home/settings.yaml` remains restored locally; the earlier `.imported` rename is documented for prod restart hygiene.

**Classification:** `PAIR_NEXT_STRUCTURED_NETWORK_REQUIREMENT_R3_PENDING_AUDIT` — STOP.
