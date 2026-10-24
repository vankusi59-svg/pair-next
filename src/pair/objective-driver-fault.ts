/** Closed driver-denial vocabulary shared by the scheduler and driver.
 * No driver -> scheduler -> driver import cycle; only real typed denial
 * instances can be promoted to durable DRIVER_* fault labels.
 */
import { IntegrityError } from "./errors.js";

/** Typed driver fault labels — durable vocabulary only, never raw
 *  error text. Mirrored into the scheduler FAULT_LABELS allowlist. */
export const DRIVER_FAULT_LABELS = [
  "DRIVER_CAP_EXHAUSTED",
  "DRIVER_COST_UNVERIFIED",
  "DRIVER_COST_HALTED",
  "DRIVER_AUTHORITY_LOST",
  "DRIVER_PASS_FAULT",
  "DRIVER_ADMISSION_DENIED",
  // AUDIT R1 F2/F4 — unconditional subscription-only denials.
  "DRIVER_METERED_FORBIDDEN",
  "DRIVER_SUBSCRIPTION_UNVERIFIED",
] as const;
export type DriverFaultLabel = (typeof DRIVER_FAULT_LABELS)[number];

export class DriverDenial extends IntegrityError {
  constructor(
    public readonly label: DriverFaultLabel,
    detail: string,
    /** Transient denials release the lease for a later retry;
     *  permanent denials quarantine for owner action. */
    public readonly transient: boolean,
  ) {
    super(`FAIL_CLOSED_${label}`, detail);
  }
}

