import { gloss } from "../../lib/gloss";

/* C.5 empty-family states — the four named renderers shared by every page. */

export function EmptyState(props: { title: string; detail: string }) {
  return (
    <div className="pstate" role="status">
      <div className="icon" aria-hidden>◇</div>
      <div className="t">{props.title}</div>
      <div className="d">{props.detail}</div>
    </div>
  );
}

export function ErrorState(props: { code?: string; detail?: string; onRetry?: () => void }) {
  return (
    <div className="pstate err" role="alert">
      <div className="icon" aria-hidden>⚠</div>
      <div className="t">{gloss(props.code)}</div>
      {props.detail ? <div className="d">{props.detail}</div> : null}
      {props.code ? <div className="code">{props.code}</div> : null}
      {props.onRetry ? (
        <button className="tbtn" style={{ marginTop: 12 }} onClick={props.onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function DeniedState(props: { detail?: string }) {
  return (
    <div className="pstate denied" role="alert">
      <div className="icon" aria-hidden>⛔</div>
      <div className="t">Access denied</div>
      <div className="d">
        {props.detail ??
          "Your session token or operator id doesn't have access here. Check them in Settings."}
      </div>
    </div>
  );
}

export function UnverifiedPanel(props: { title?: string; detail: string }) {
  return (
    <div className="pstate unver" role="note">
      <div className="icon" aria-hidden>◐</div>
      <div className="t">{props.title ?? "Cannot be verified"}</div>
      <div className="d">{props.detail} Claims shown are labeled as claims — never as verified.</div>
    </div>
  );
}

export function Skeleton(props: { height?: number; width?: string }) {
  return (
    <div
      className="skel"
      style={{ height: props.height ?? 14, width: props.width ?? "100%" }}
      aria-hidden
    />
  );
}
