import { useEffect, useState } from "react";

interface Toast {
  id: number;
  kind: "ok" | "err" | "info";
  msg: string;
}

let nextId = 0;
const subs = new Set<(t: Toast) => void>();

export function toast(msg: string, kind: Toast["kind"] = "info") {
  for (const s of subs) s({ id: ++nextId, kind, msg });
}

export function Toasts() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const sub = (t: Toast) => {
      setItems((xs) => [...xs, t]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 5000);
    };
    subs.add(sub);
    return () => {
      subs.delete(sub);
    };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast t-${t.kind}`} onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}
