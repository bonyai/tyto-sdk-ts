export class TytoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TytoError";
  }
}

export class TytoApiError extends TytoError {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "TytoApiError";
  }
}
