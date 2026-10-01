/** PAIR error taxonomy ported from donor standalone_core/errors.py. */

export class PairError extends Error {
  constructor(
    public readonly code: string,
    public readonly detail: string,
    /** Structured context carried alongside the code for recovery evidence
     *  (e.g. the executor a route-selection failure was scoped to). Never
     *  part of the message — classification keys off `code` only. */
    public readonly meta?: Record<string, unknown>,
  ) {
    super(`${code}:${detail}`);
    this.name = new.target.name;
  }
}

export class IntegrityError extends PairError {}
export class PolicyError extends PairError {}
export class NotFoundError extends PairError {
  constructor(detail: string) {
    super("NOT_FOUND", detail);
  }
}
export class StateTransitionError extends PairError {
  constructor(detail: string) {
    super("FAIL_CLOSED_STATE_TRANSITION", detail);
  }
}
