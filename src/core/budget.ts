import { ExecutionLimitsSchema, HARD_LIMITS, type ExecutionLimits } from "./contracts.js";
import { byteLength } from "./canonical.js";
import { EngineError } from "./errors.js";

export class ExecutionBudget {
  readonly deadline: number;
  readonly maxResponseBytes: number;

  constructor(limits?: ExecutionLimits, startedAt = performance.now()) {
    const timeout = limits?.timeout_ms ?? HARD_LIMITS.defaultTimeoutMs;
    this.deadline = startedAt + timeout;
    this.maxResponseBytes = limits?.max_response_bytes ?? HARD_LIMITS.maxResponseBytes;
  }

  check(): void {
    if (performance.now() > this.deadline) {
      throw new EngineError("TIMEOUT", "The dependency calculation exceeded its wall-clock limit.");
    }
  }

  assertResponse(value: unknown): void {
    this.check();
    const actual = byteLength(value);
    this.check();
    if (actual > this.maxResponseBytes) {
      throw new EngineError(
        "RESPONSE_TOO_LARGE",
        `The complete result requires ${actual} bytes, above the ${this.maxResponseBytes}-byte limit.`,
        { actual_bytes: actual, max_response_bytes: this.maxResponseBytes },
      );
    }
  }
}

export function executionLimitsFromInput(value: unknown): ExecutionLimits | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const parsed = ExecutionLimitsSchema.safeParse((value as Record<string, unknown>).limits);
  return parsed.success ? parsed.data : undefined;
}

export function responseLimitFromInput(value: unknown): number {
  return executionLimitsFromInput(value)?.max_response_bytes ?? HARD_LIMITS.maxResponseBytes;
}

export function timeoutFromInput(value: unknown): number {
  return executionLimitsFromInput(value)?.timeout_ms ?? HARD_LIMITS.defaultTimeoutMs;
}

export function deadlineExceeded(value: unknown, startedAt: number): boolean {
  return performance.now() > startedAt + timeoutFromInput(value);
}

// requestBytes, when provided, must equal byteLength(value) as computed by the
// calling adapter for the exact same value; adapters that already serialized
// the request for routing pass it through instead of serializing a second time.
export function assertRequestSize(value: unknown, requestBytes?: number): void {
  if (requestBytes !== undefined && (!Number.isSafeInteger(requestBytes) || requestBytes < 0)) {
    throw new EngineError("INTERNAL_ERROR", "The adapter supplied an invalid request-size measurement.");
  }
  let actual: number;
  try {
    actual = requestBytes ?? byteLength(value);
  } catch {
    throw new EngineError("INVALID_REQUEST", "The request must be JSON-serializable.");
  }
  if (actual > HARD_LIMITS.maxRequestBytes) {
    throw new EngineError(
      "REQUEST_TOO_LARGE",
      `The request requires ${actual} bytes, above the ${HARD_LIMITS.maxRequestBytes}-byte limit.`,
      { actual_bytes: actual, max_request_bytes: HARD_LIMITS.maxRequestBytes },
    );
  }
}
