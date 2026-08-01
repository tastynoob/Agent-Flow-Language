import type { JsonValue } from "./ir.js";
import { isJsonValue } from "./value.js";

export interface SerializedFlowError {
  code: string;
  message: string;
  nodeId?: string;
  details?: JsonValue;
}

export class FlowRuntimeError extends Error {
  readonly code: string;
  readonly nodeId: string | undefined;
  readonly details: JsonValue | undefined;

  constructor(
    code: string,
    message: string,
    options: { nodeId?: string; details?: JsonValue; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FlowRuntimeError";
    this.code = code;
    this.nodeId = options.nodeId;
    this.details = options.details;
  }

  withNode(nodeId: string): FlowRuntimeError {
    if (this.nodeId !== undefined) {
      return this;
    }
    return new FlowRuntimeError(this.code, this.message, {
      nodeId,
      ...(this.details === undefined ? {} : { details: this.details }),
      cause: this,
    });
  }

  serialize(): SerializedFlowError {
    return {
      code: this.code,
      message: this.message,
      ...(this.nodeId === undefined ? {} : { nodeId: this.nodeId }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function normalizeRuntimeError(error: unknown, nodeId?: string): FlowRuntimeError {
  if (error instanceof FlowRuntimeError) {
    return nodeId === undefined ? error : error.withNode(nodeId);
  }
  if (error instanceof Error) {
    return new FlowRuntimeError("ADAPTER_ERROR", error.message, {
      ...(nodeId === undefined ? {} : { nodeId }),
      cause: error,
    });
  }
  return new FlowRuntimeError("UNKNOWN_ERROR", "unknown runtime error", {
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(isJsonValue(error) ? { details: error } : {}),
    cause: error,
  });
}
