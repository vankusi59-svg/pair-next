/**
 * ceo-runtime — P15.3W runtime wiring for the CEO Planning Cycle.
 *
 * ONE composition seam: resolve the canonical CEO model through the
 * EXISTING provider/model catalog authority, construct the production
 * Codex CLI invoker, and hand a fully-wired CeoPlanningCycleService to
 * the runtime. Callers never look up or pass model_entry_id.
 *
 * This module is composition ONLY. It introduces no new authority, no
 * schema, no executor/mission/delegation path, no loop/scheduler:
 *   resolve canonical codex-cli model_entry (existing catalog +
 *   qualification + eligibility gates)
 *     → CodexCliCeoDecisionInvoker (existing P15.3 transport)
 *       → CeoPlanningCycleService.runCycle (existing P15.3 semantics)
 */

import { IntegrityError } from "./errors.js";
import { canonicalModelId } from "./model-catalog.js";
import {
  CODEX_CLI_PROVIDER_ID,
  type CodexCliEnv,
} from "./codex-cli-transport.js";
import {
  CEO_CODEX_DEFAULT_MODEL,
  CodexCliCeoDecisionInvoker,
  resolveCeoModelTransport,
  type CeoDecisionInvoker,
  type CeoModelTransport,
} from "./ceo-decision.js";
import {
  assertCeoModelUsable,
  CeoPlanningCycleService,
  type CeoObservationDeps,
} from "./ceo-planning-cycle.js";
/* P16-C brief wiring closes a managed ESM cycle (ceo-runtime →
   brain-context → objective-cockpit → objective-adaptive-review →
   ceo-runtime + reasoning-brief → ceo-planning-cycle). All cross-
   references are call-time bindings or hoisted export functions —
   keep it that way: no eval-time use of the cyclic modules here. */
import { BrainContextService, type BrainContextDeps } from "./brain-context.js";
import {
  briefObservationView,
  ReasoningBriefService,
} from "./reasoning-brief.js";
import { ObjectiveWorkstreamService } from "./objective-workstream.js";
import type { BusinessLayer } from "./business.js";
import type { ObjectiveAuthorityService } from "./objective-authority.js";
import type { PairEvidenceStore } from "./store.js";
import type { WorkforceService } from "./work-graph.js";

type Row = Record<string, unknown> & { version: number };

/**
 * Resolve the configured default CEO model (`codex-cli:gpt-6.1-sol`)
 * to its canonical model_entry_id — pure read of the existing
 * provider/model catalog plus the SAME authority gates the cycle
 * applies at claim time. Never seeds, never bypasses qualification:
 * missing entry, ambiguous duplicate identity, non-codex transport
 * facets, revoked/unqualified/unavailable/DSH-conflicting entries all
 * fail closed with a typed IntegrityError.
 */
export function resolveDefaultCeoModelEntry(store: PairEvidenceStore): string {
  // Deterministic canonical id — resolution is never a guess.
  const canonicalId = canonicalModelId(
    CODEX_CLI_PROVIDER_ID, CEO_CODEX_DEFAULT_MODEL);
  if (!store.tryGet("model_entry", canonicalId)) {
    throw new IntegrityError(
      "FAIL_CLOSED_CEO_MODEL_UNRESOLVED",
      `default CEO model ${CODEX_CLI_PROVIDER_ID}:${CEO_CODEX_DEFAULT_MODEL} is not cataloged`,
    );
  }
  // Ambiguity — catalog semantics make (provider_id, model_id) a single
  // canonical id. A second row claiming the same identity (reachable
  // only through a non-canonical write) is corrupt authority.
  const claiming = (store.list("model_entry") as Row[]).filter(
    (m) => String(m.provider_id ?? "") === CODEX_CLI_PROVIDER_ID &&
           String(m.model_id ?? "") === CEO_CODEX_DEFAULT_MODEL &&
           String(m.model_entry_id) !== canonicalId);
  if (claiming.length > 0) {
    throw new IntegrityError(
      "FAIL_CLOSED_CEO_MODEL_AMBIGUOUS",
      `${claiming.length} foreign model_entry row(s) claim ${CODEX_CLI_PROVIDER_ID}:${CEO_CODEX_DEFAULT_MODEL}`,
    );
  }
  // Codex-cli transport identity (provider/protocol/endpoint gates —
  // R3.B) BEFORE availability, matching the cycle's re-proof order.
  resolveCeoModelTransport(store, canonicalId);
  // The ONE eligibility gate — same function runCycle asserts: revoked
  // conditions, DSH_EXECUTION disjointness (direct + alias), and the
  // providerModelEligibility projection.
  assertCeoModelUsable(store, canonicalId);
  return canonicalId;
}

export interface CeoRuntimeComposition {
  store: PairEvidenceStore;
  business: BusinessLayer;
  workforce: WorkforceService;
  /** Pre-built services may be injected for composition; defaults
   *  derive from business + workforce through the canonical seams. */
  objectives?: ObjectiveAuthorityService;
  workstreams?: ObjectiveWorkstreamService;
  proveWorkItemDone?: CeoObservationDeps["proveWorkItemDone"];
  /** Transport-boundary injection point (tests). Production callers
   *  leave this unset — the default is the real Codex CLI invoker. */
  invoker?: CeoDecisionInvoker;
  /** Options forwarded to CodexCliCeoDecisionInvoker when `invoker`
   *  is not injected. */
  invoker_options?: {
    env?: CodexCliEnv;
    executable?: string;
    scratchDir?: string;
  };
  /** P16-C — advisory brief projection seam for the observation.
   *  Injected verbatim into CeoObservationDeps.brain_brief (tests and
   *  richer compositions may wire autoPolicy/autoDriver/artifacts).
   *  When omitted, a default BrainContext + ReasoningBrief stack is
   *  composed over the same strict reads bound to the resolved CEO
   *  model entry; optional sections with no wired authority report
   *  *_NOT_WIRED honestly. */
  brain_brief?: CeoObservationDeps["brain_brief"];
  /** P17 — optional scoped advisory surfaces forwarded into the
   *  default BrainContextService (ignored when brain_brief is
   *  injected — the injected seam owns its own wiring). */
  experience?: BrainContextDeps["experience"];
  scopedMemory?: BrainContextDeps["scopedMemory"];
  timeout_ms?: number;
  stale_grace_ms?: number;
  now?: () => string;
}

export interface DefaultCeoCycle {
  service: CeoPlanningCycleService;
  model_entry_id: string;
  transport: CeoModelTransport;
}

/**
 * The public runtime seam: callers hand over the already-materialized
 * business + workforce stack and receive a wired CEO planning cycle.
 * No caller-side model_entry_id; no duplicated controller logic.
 */
export function createDefaultCeoPlanningCycle(
  deps: CeoRuntimeComposition,
): DefaultCeoCycle {
  const modelEntryId = resolveDefaultCeoModelEntry(deps.store);
  const transport = resolveCeoModelTransport(deps.store, modelEntryId);
  const objectives = deps.objectives ?? deps.business.objectives;
  const workstreams = deps.workstreams ?? new ObjectiveWorkstreamService({
    store: deps.store,
    business: deps.business,
    workforce: deps.workforce,
    objectives,
  });
  const proveWorkItemDone = deps.proveWorkItemDone ??
    ((row) => deps.business.proveWorkItemDone(row as never));
  const invoker = deps.invoker ??
    new CodexCliCeoDecisionInvoker(deps.invoker_options ?? {});
  // P16-C — default advisory brief stack: the owner's governed
  // BrainContext projected through briefObservationView (digest-stable
  // subset only). Zero writes, zero invocations — the same seam the
  // P16-B surface uses, bound to THIS cycle's canonical model entry.
  const brain_brief = deps.brain_brief ?? (() => {
    const briefs = new ReasoningBriefService(deps.store, {
      brain: new BrainContextService({
        store: deps.store,
        business: deps.business,
        workforce: deps.workforce,
        objectives,
        workstreams,
        // P17 — scoped tenancy readers; absent deps report *_NOT_WIRED.
        experience: deps.experience,
        scopedMemory: deps.scopedMemory,
      }),
      model_entry_id: modelEntryId,
    });
    return (objectiveId: string, ownerActor: string) =>
      briefObservationView(briefs.briefFor(objectiveId, ownerActor));
  })();
  const service = new CeoPlanningCycleService({
    store: deps.store,
    objectives,
    workstreams,
    proveWorkItemDone,
    brain_brief,
    invoker,
    model_entry_id: modelEntryId,
    timeout_ms: deps.timeout_ms,
    stale_grace_ms: deps.stale_grace_ms,
    now: deps.now,
  });
  return { service, model_entry_id: modelEntryId, transport };
}

/**
 * One-shot convenience: wire the default CEO cycle and run it once.
 * Identical authority path — this is a thin composition over
 * createDefaultCeoPlanningCycle + runCycle, never a second controller.
 */
export async function runDefaultCeoCycle(
  deps: CeoRuntimeComposition & { objective_id: string; actor: string },
): Promise<{
  decision: Row;
  binding: Row | null;
  attempt_id: string;
  replayed: boolean;
  model_entry_id: string;
}> {
  const { service, model_entry_id } = createDefaultCeoPlanningCycle(deps);
  const result = await service.runCycle({
    objective_id: deps.objective_id,
    actor: deps.actor,
  });
  return { ...result, model_entry_id };
}
