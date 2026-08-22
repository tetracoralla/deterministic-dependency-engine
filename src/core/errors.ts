import { z } from "zod";
import type { ErrorResult } from "./contracts.js";
import { byteLength } from "./canonical.js";

export class EngineError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function boundedZodIssues(error: z.ZodError): unknown[] {
  return error.issues.slice(0, 24).map((issue) => ({
    code: issue.code,
    path: issue.path.map(String).slice(0, 12),
    message: issue.message.slice(0, 256),
  }));
}

export function toEngineError(error: unknown): EngineError {
  if (error instanceof EngineError) return error;
  if (error instanceof z.ZodError) {
    return new EngineError("INVALID_REQUEST", "The request does not match the operation schema.", {
      issues: boundedZodIssues(error),
    });
  }
  if (error instanceof Error) {
    return new EngineError("INTERNAL_ERROR", "The dependency calculation failed unexpectedly.");
  }
  return new EngineError("INTERNAL_ERROR", "The dependency calculation failed unexpectedly.");
}

export function errorResult(error: unknown): ErrorResult {
  const normalized = toEngineError(error);
  return {
    status: "error",
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
    },
  };
}

export function responseTooLargeResult(
  actualBytes: number,
  maxResponseBytes: number,
  originalCode?: string,
): ErrorResult {
  return {
    status: "error",
    error: {
      code: "RESPONSE_TOO_LARGE",
      message: `The complete response requires ${actualBytes} bytes, above the ${maxResponseBytes}-byte limit.`,
      ...(originalCode === undefined ? {} : { details: { original_code: originalCode } }),
    },
  };
}

export function boundedErrorResult(error: unknown, maxResponseBytes: number): ErrorResult {
  const result = errorResult(error);
  const actualBytes = byteLength(result);
  if (actualBytes <= maxResponseBytes) return result;
  const bounded = responseTooLargeResult(actualBytes, maxResponseBytes, result.error.code);
  if (byteLength(bounded) <= maxResponseBytes) return bounded;
  return {
    status: "error",
    error: {
      code: "RESPONSE_TOO_LARGE",
      message: "The complete response exceeds the selected byte limit.",
    },
  };
}

export function timeoutResult(maxResponseBytes: number): ErrorResult {
  return boundedErrorResult(
    new EngineError("TIMEOUT", "The dependency calculation exceeded its wall-clock limit."),
    maxResponseBytes,
  );
}
