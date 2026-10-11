import { gloss } from "../../lib/gloss";

export type Tone = "ok" | "warn" | "danger" | "info" | "purple" | "unknown";

/* The ONE badge component (C.4): label + optional canonical code with gloss.
   Color is never the only signal — the text label is always rendered. */
export function StatusBadge(props: {
  tone: Tone;
  label: string;
  code?: string;
  title?: string;
}) {
  return (
    <span className={`sbadge t-${props.tone}`} title={props.title ?? (props.code ? gloss(props.code) : undefined)}>
      <span>{props.label}</span>
      {props.code ? <span className="code">{props.code}</span> : null}
    </span>
  );
}

/* ProofChip — canonically_proven renderer (C.4): proven / claimed /
   unverifiable — never a bare checkmark. */
export function ProofChip(props: { state: "proven" | "claimed" | "unverifiable" }) {
  const label =
    props.state === "proven" ? "proven" : props.state === "claimed" ? "claimed" : "unverifiable";
  return <span className={`pchip ${props.state}`}>◐{label}</span>;
}
