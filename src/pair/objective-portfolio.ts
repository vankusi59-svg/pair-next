/**
 * P18-B — Business portfolio projection over canonical
 * objective_relation.
 *
 * READ-ONLY by construction: every field composes existing strict
 * canonical reads (`objectives.strictEnumerate`,
 * `relations.relationsForBusiness`) — no `store.put`, no `store.event`,
 * no service mutation is reachable from this service. The projection
 * is ADVISORY: it renders the proven relation graph and derived
 * dependency state for the owner; it never gates admission, scheduling,
 * or execution (that is P18-C's job, consuming the same canonical
 * seams server-side).
 *
 * Authority contract (identical to the company cockpit):
 *  - the caller's actor is `operator:<x-operator-id>` derived at the
 *    HTTP edge (never trusted from a body field);
 *  - the projection lists ONLY objectives the actor owns inside the
 *    business — an actor owning none gets FAIL_CLOSED_PORTFOLIO_SCOPE;
 *  - only relations whose BOTH endpoints are owned objectives enter the
 *    projection. Canonical relations are bilaterally owner-scoped
 *    (created_by must equal the CURRENT owner of both endpoints), so a
 *    proven edge can never span owners — the both-endpoints-owned
 *    filter is the honest local check that does not rely on that
 *    invariant holding.
 *
 * Dependency semantics (advisory, DEPENDS_ON from=dependent →
 * to=upstream):
 *  - SATISFIED — ACTIVE edge whose upstream objective is ACHIEVED;
 *  - PENDING   — ACTIVE edge whose upstream is non-terminal;
 *  - FAILED    — ACTIVE edge whose upstream is terminal-but-not-
 *    ACHIEVED (INFEASIBLE/EXPIRED/CANCELLED): the dependency can never
 *    be satisfied without owner action (revoke / supersede);
 *  - state SUSPENDED / REVOKED render as their state — only ACTIVE
 *    edges derive blocked.
 *
 *  Recovery bound (P18-F): satisfaction here judges the upstream's own
 *  status only — it does NOT walk the supersession DAG. A FAILED edge
 *  whose upstream has an achieved declared replacement still reports
 *  FAILED/blocked even though the scheduler gate now releases
 *  admission. This surface is advisory; the gate is canonical.
 *
 * Consistency bound: the read is not transactional — the strict
 * objective enumeration and the relation re-proof are two snapshots.
 * An owner amendment landing between them can render an objective the
 * actor no longer owns (stale render of owner-authored data only): an
 * EDGE can never leak through it, because proven relations require
 * created_by === CURRENT owner of both endpoints at relation-read
 * time. The same mixed-snapshot bound exists on the company cockpit.
 */
import { IntegrityError } from "./errors.js";
import type { PairEvidenceStore } from "./store.js";
import type { Row } from "./routine-mirror.js";
import {
  TERMINAL_OBJECTIVE_STATUSES,
  type ObjectiveAuthorityService,
  type ObjectiveStatus,
} from "./objective-authority.js";
import type {
  ObjectiveRelationRow,
  ObjectiveRelationService,
} from "./objective-relation.js";

const MAX_LIST = 200;

export interface ObjectivePortfolioDeps {
  store: PairEvidenceStore;
  objectives: Pick<ObjectiveAuthorityService, "strictEnumerate">;
  relations: Pick<ObjectiveRelationService, "relationsForBusiness">;
}

/** Deterministic code-unit ordering (localeCompare is env-dependent). */
function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type EdgeSatisfaction = "SATISFIED" | "PENDING" | "FAILED" | "SUSPENDED" | "REVOKED";

function upstreamSatisfaction(
  edge: ObjectiveRelationRow,
  upstream: Row,
): EdgeSatisfaction {
  if (edge.state === "SUSPENDED") return "SUSPENDED";
  if (edge.state === "REVOKED") return "REVOKED";
  const s = String(upstream.status);
  if (s === "ACHIEVED") return "SATISFIED";
  if (TERMINAL_OBJECTIVE_STATUSES.has(s as ObjectiveStatus)) return "FAILED";
  return "PENDING";
}

export class ObjectivePortfolioService {
  constructor(private readonly deps: ObjectivePortfolioDeps) {}

  /** GET /api/vnext/businesses/:id/portfolio — the business header,
   *  the actor's owned objectives annotated with their proven relation
   *  graph, and honest graph counts. */
  businessPortfolio(businessId: string, actor: string): Record<string, unknown> {
    const biz = this.deps.store.get("business", businessId) as Row;
    // Scope is proven by strictEnumerate — a tampered objective
    // anywhere fails this read closed (see ObjectiveAuthorityService).
    const ownedStrict = this.deps.objectives.strictEnumerate()
      .filter(
        (o) =>
          String(o.business_id) === businessId &&
          String(o.owner_authority_id) === actor,
      )
      .sort(
        (a, b) =>
          String(a.created_at).localeCompare(String(b.created_at)) ||
          byId(String(a.objective_id), String(b.objective_id)),
      );
    if (ownedStrict.length === 0) {
      throw new IntegrityError(
        "FAIL_CLOSED_PORTFOLIO_SCOPE",
        `actor ${actor} owns no objectives in ${businessId}`,
      );
    }
    const ownedIds = new Set(ownedStrict.map((o) => String(o.objective_id)));
    const byObjectiveId = new Map(ownedStrict.map((o) => [String(o.objective_id), o]));

    // Only proven relations; only edges entirely inside the owned
    // scope — a foreign endpoint never enters the projection even if
    // a future relation kind ever permitted cross-owner edges.
    const edges = this.deps.relations
      .relationsForBusiness(businessId)
      .filter(
        (r) => ownedIds.has(r.from_objective_id) && ownedIds.has(r.to_objective_id),
      )
      .sort((a, b) => byId(a.relation_id, b.relation_id));

    const dependsOn = new Map<string, ObjectiveRelationRow[]>();
    const dependents = new Map<string, ObjectiveRelationRow[]>();
    const conflicts = new Map<string, ObjectiveRelationRow[]>();
    const supersedes = new Map<string, ObjectiveRelationRow[]>();
    const supersededBy = new Map<string, ObjectiveRelationRow[]>();
    const push = (m: Map<string, ObjectiveRelationRow[]>, k: string, r: ObjectiveRelationRow) => {
      const xs = m.get(k);
      if (xs) xs.push(r);
      else m.set(k, [r]);
    };
    for (const r of edges) {
      if (r.kind === "DEPENDS_ON") {
        push(dependsOn, r.from_objective_id, r);
        push(dependents, r.to_objective_id, r);
      } else if (r.kind === "CONFLICTS") {
        push(conflicts, r.from_objective_id, r);
        push(conflicts, r.to_objective_id, r);
      } else {
        // SUPERSEDES: `from` supersedes `to`.
        push(supersedes, r.from_objective_id, r);
        push(supersededBy, r.to_objective_id, r);
      }
    }

    const edgeRef = (
      r: ObjectiveRelationRow,
      counterparty: string,
      extra?: Record<string, unknown>,
    ): Record<string, unknown> => ({
      relation_id: r.relation_id,
      counterparty_objective_id: counterparty,
      state: r.state,
      ...extra,
    });

    const summaries = ownedStrict.slice(0, MAX_LIST).map((o) => {
      const oid = String(o.objective_id);
      const deps = (dependsOn.get(oid) ?? [])
        .slice()
        .sort((a, b) => byId(a.relation_id, b.relation_id))
        .map((r) =>
          edgeRef(r, r.to_objective_id, {
            satisfaction: upstreamSatisfaction(r, byObjectiveId.get(r.to_objective_id)!),
          }),
        );
      const active = deps.filter((d) => d.state === "ACTIVE");
      const pending = active.filter((d) => d.satisfaction === "PENDING").length;
      const failed = active.filter((d) => d.satisfaction === "FAILED").length;
      return {
        objective_id: oid,
        title: o.title ?? null,
        status: String(o.status),
        deadline: o.deadline ?? null,
        created_at: String(o.created_at ?? ""),
        depends_on: deps,
        dependents: (dependents.get(oid) ?? [])
          .slice()
          .sort((a, b) => byId(a.relation_id, b.relation_id))
          .map((r) => edgeRef(r, r.from_objective_id)),
        conflicts: (conflicts.get(oid) ?? [])
          .slice()
          .sort((a, b) => byId(a.relation_id, b.relation_id))
          .map((r) =>
            edgeRef(
              r,
              r.from_objective_id === oid ? r.to_objective_id : r.from_objective_id,
            ),
          ),
        supersedes: (supersedes.get(oid) ?? [])
          .slice()
          .sort((a, b) => byId(a.relation_id, b.relation_id))
          .map((r) => edgeRef(r, r.to_objective_id)),
        superseded_by: (supersededBy.get(oid) ?? [])
          .slice()
          .sort((a, b) => byId(a.relation_id, b.relation_id))
          .map((r) => edgeRef(r, r.from_objective_id)),
        dependency: {
          upstream_active: active.length,
          upstream_satisfied: active.filter((d) => d.satisfaction === "SATISFIED").length,
          upstream_pending: pending,
          upstream_failed: failed,
          // The advisory gate signal P18-C consumes canonically:
          // unsatisfied ACTIVE upstream means the objective may not
          // proceed. PENDING and FAILED both block — FAILED means the
          // block can never resolve without owner action.
          blocked: pending + failed > 0,
        },
        active_conflicts: (conflicts.get(oid) ?? []).filter((r) => r.state === "ACTIVE").length,
      };
    });

    const byKind = { DEPENDS_ON: 0, CONFLICTS: 0, SUPERSEDES: 0 };
    const byState = { ACTIVE: 0, SUSPENDED: 0, REVOKED: 0 };
    for (const r of edges) {
      byKind[r.kind]++;
      byState[r.state]++;
    }

    return {
      business: {
        business_id: String(biz.business_id),
        name: String(biz.name),
        description: biz.description ?? null,
        currency: String(biz.currency ?? "USD"),
        status: String(biz.status),
        project_id: String(biz.project_id),
        created_at: String(biz.created_at ?? ""),
      },
      objectives: summaries,
      edges: edges.map((r) => ({
        relation_id: r.relation_id,
        kind: r.kind,
        state: r.state,
        from_objective_id: r.from_objective_id,
        to_objective_id: r.to_objective_id,
        note: r.note,
        created_at: r.created_at,
      })),
      counts: {
        objectives_owned: ownedStrict.length,
        objectives_returned: summaries.length,
        objectives_dependency_blocked: ownedStrict
          .filter((o) => {
            const oid = String(o.objective_id);
            return (dependsOn.get(oid) ?? []).some((r) => {
              if (r.state !== "ACTIVE") return false;
              const s = upstreamSatisfaction(r, byObjectiveId.get(r.to_objective_id)!);
              return s === "PENDING" || s === "FAILED";
            });
          }).length,
        relations_total: edges.length,
        relations_by_kind: byKind,
        relations_by_state: byState,
      },
      objectives_truncated: ownedStrict.length > summaries.length,
    };
  }
}
