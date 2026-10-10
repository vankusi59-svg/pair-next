import { useEffect, useRef, type ReactNode } from "react";

/* Minimal accessible confirm dialog for B3 mutations (mandate §8 /
   R1-F4): explicit confirm/cancel, Esc closes, focus trapped inside,
   focus returns to the element that opened it, buttons labeled. */
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  busy?: boolean;
  /* B4 R1-F2: fail-closed confirmations (e.g. missing canonical scope)
     disable confirm independently of in-flight busy state. */
  confirmDisabled?: boolean;
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!props.open) { wasOpen.current = false; return; }
    if (!wasOpen.current) {
      wasOpen.current = true;
      opener.current = document.activeElement;
      ref.current?.querySelector<HTMLElement>(".cdlg-x")?.focus();
    }
  }, [props.open]);

  useEffect(() => {
    if (!props.open && opener.current) {
      /* focus return on close (dialog, Escape or backdrop alike) */
      (opener.current as HTMLElement).focus?.();
      opener.current = null;
    }
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); props.onCancel(); return; }
      if (e.key !== "Tab" || !ref.current) return;
      const els = ref.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [href], input, select, textarea",
      );
      if (els.length === 0) return;
      const first = els[0]!, last = els[els.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [props.open, props]);

  if (!props.open) return null;
  return (
    <div className="cdlg-wrap" onClick={props.onCancel}>
      <div
        className="cdlg"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cdlg-h">
          <strong>{props.title}</strong>
          <button className="cdlg-x" aria-label="Close dialog" onClick={props.onCancel}>✕</button>
        </div>
        <p className="cdlg-b">{props.body}</p>
        {props.children}
        <div className="cdlg-f">
          <button className="ghost" onClick={props.onCancel} disabled={props.busy}>Cancel</button>
          <button className="primary" onClick={props.onConfirm} disabled={props.busy || props.confirmDisabled}>
            {props.busy ? "Working…" : props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
