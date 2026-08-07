import type { ComputeValue, SourceSpan } from "./ir.js";

export interface AflDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity?: "warning";
  readonly span: SourceSpan;
  readonly sourceName?: string;
}

export class AflParseError extends Error {
  readonly diagnostics: readonly AflDiagnostic[];

  constructor(diagnostics: readonly AflDiagnostic[]) {
    super(diagnostics[0]?.message ?? "AFL source could not be parsed");
    this.name = "AflParseError";
    this.diagnostics = diagnostics;
  }
}

export class AflValidationError extends Error {
  readonly diagnostics: readonly AflDiagnostic[];

  constructor(diagnostics: readonly AflDiagnostic[]) {
    super(diagnostics[0]?.message ?? "AFL module is invalid");
    this.name = "AflValidationError";
    this.diagnostics = diagnostics;
  }
}

export interface SerializedVmError {
  readonly code: string;
  readonly message: string;
  readonly span?: SourceSpan;
  readonly details?: ComputeValue;
}

export class AflVmError extends Error {
  readonly code: string;
  readonly span: SourceSpan | undefined;
  readonly details: ComputeValue | undefined;

  constructor(
    code: string,
    message: string,
    options: { span?: SourceSpan; details?: ComputeValue; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AflVmError";
    this.code = code;
    this.span = options.span;
    this.details = options.details;
  }

  withSpan(span: SourceSpan): AflVmError {
    if (this.span !== undefined) {
      return this;
    }
    return new AflVmError(this.code, this.message, {
      span,
      ...(this.details === undefined ? {} : { details: this.details }),
      cause: this,
    });
  }

  serialize(): SerializedVmError {
    return {
      code: this.code,
      message: this.message,
      ...(this.span === undefined ? {} : { span: this.span }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function normalizeVmError(
  error: unknown,
  span?: SourceSpan,
): AflVmError {
  if (error instanceof AflVmError) {
    return span === undefined ? error : error.withSpan(span);
  }
  if (error instanceof Error) {
    return new AflVmError("ADAPTER_ERROR", error.message, {
      ...(span === undefined ? {} : { span }),
      cause: error,
    });
  }
  return new AflVmError("UNKNOWN_ERROR", "unknown VM error", {
    ...(span === undefined ? {} : { span }),
    ...(isComputeDetail(error) ? { details: error } : {}),
    cause: error,
  });
}

function isComputeDetail(value: unknown): value is ComputeValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isComputeDetail);
  }
  return typeof value === "object" && value !== null &&
    Object.values(value).every(isComputeDetail);
}
