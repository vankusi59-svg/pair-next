import { EmptyState } from "../components/states";

/* Honest placeholder for B2–B6 routes (mandate §3): states exactly what the
   page will be and which roadmap PR lands it — never fake data or buttons. */
export function PlannedPage(props: { title: string; detail: string; phase: string }) {
  return (
    <>
      <h1>{props.title}</h1>
      <div className="sub">Planned — no business data rendered yet.</div>
      <EmptyState title="Not implemented yet" detail={props.detail} />
      <span className="pplan">lands in {props.phase}</span>
    </>
  );
}
