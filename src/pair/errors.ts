/** PAIR error taxonomy ported from donor standalone_core/errors.py. */

export class PairError extends Error {
  constructor(
    public readonly code: string,
    public readonly detail: string,
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
