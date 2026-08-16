export type HelperExitCode = 0 | 1 | 2 | 130;

export class HelperFailure extends Error {
  constructor(
    readonly exitCode: Exclude<HelperExitCode, 0>,
    readonly diagnostic: string,
  ) {
    super(diagnostic);
    this.name = "HelperFailure";
  }
}

export function operationFailure(diagnostic: string): HelperFailure {
  return new HelperFailure(1, diagnostic);
}

export function protocolFailure(diagnostic: string): HelperFailure {
  return new HelperFailure(2, diagnostic);
}

export function cancellationFailure(): HelperFailure {
  return new HelperFailure(130, "cancelled");
}

export function normalizeFailure(error: unknown): HelperFailure {
  return error instanceof HelperFailure
    ? error
    : operationFailure("operation-failed");
}
