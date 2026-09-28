import { api } from "../api";
import { useApi } from "../hooks/useApi";

export function Approvals() {
  const q = useApi(() => api.approvals(), [], 4000);
  const list = (q.data ?? []) as Array<Record<string, unknown>>;

  const act = async (a: Record<string, unknown>, kind: "approve" | "deny") => {
    const id = String(a.approval_id ?? a.entity_id);
    const scope = (a.scope ?? {}) as Record<string, unknown>;
    try {
      await (kind === "approve" ? api.approve(id, scope) : api.deny(id, scope));
      q.reload();
    } catch (e) {
      alert(String(e));
    }
  };

  return (
    <div className="page">
      <h1>Approvals inbox</h1>
      {list.length === 0 ? (
        <div className="state empty">No approval requests.</div>
      ) : (
        <table className="tbl">
          <thead><tr><th>Approval</th><th>Mission</th><th>Reason</th><th>Status</th><th /></tr></thead>
          <tbody>
            {list.map((a) => {
              const id = String(a.approval_id ?? a.entity_id);
              return (
                <tr key={id}>
                  <td className="mono">{id.slice(0, 20)}</td>
                  <td className="mono">{String(a.mission_id ?? "").slice(0, 20)}</td>
                  <td>{String(a.reason ?? a.kind ?? "")}</td>
                  <td>{String(a.status)}</td>
                  <td>
                    {a.status === "PENDING" && (
                      <span className="row">
                        <button onClick={() => act(a, "approve")}>Approve</button>
                        <button className="danger" onClick={() => act(a, "deny")}>Deny</button>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
