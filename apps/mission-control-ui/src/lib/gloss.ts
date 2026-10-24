/* Canonical code → human gloss map (C.6). Extend alongside new endpoints;
   unknown codes fall back to a generic honest gloss. */

const GLOSS: Record<string, string> = {
  FAIL_CLOSED_COMPANY_SCOPE:
    "You don't own any objectives in this business — or the business isn't visible to this operator.",
  FAIL_CLOSED_COCKPIT_AUTHORITY:
    "You don't have owner authority over this objective.",
  FAIL_CLOSED_OPERATOR_ID_REQUIRED:
    "An operator id is required — set it in Settings.",
  FAIL_CLOSED_ENTITY_HASH_MISMATCH:
    "A stored record failed its integrity check; the data cannot be trusted.",
  FAIL_CLOSED_OBJECTIVE_IDENTITY:
    "A stored record's identity does not match its canonical key.",
  FAIL_CLOSED_PORTFOLIO_SCOPE:
    "You don't have owner authority over any objective in this business.",
  PORTFOLIO_DISABLED:
    "The business portfolio requires the business layer and a canonical store — unavailable in this deployment.",
  FAIL_CLOSED_COCKPIT_PROOF:
    "Required canonical proof failed; claims are shown as unverified.",
  OBJECTIVE_TERMINAL: "The objective already reached a final state.",
  COCKPIT_DISABLED:
    "The company cockpit requires the business layer and a canonical store — unavailable in this deployment.",
  UNAUTHORIZED: "Your session token is missing or invalid.",
  FORBIDDEN: "You don't have permission for this action.",
  NOT_FOUND: "The requested resource does not exist.",
  ERROR: "Something went wrong.",
};

export function gloss(code: string | null | undefined): string {
  if (!code) return GLOSS.ERROR!;
  return GLOSS[code] ?? `Canonical code: ${code}`;
}
