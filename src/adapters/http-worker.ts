import { deadlineExceeded, responseLimitFromInput } from "../core/budget.js";
import { byteLength } from "../core/canonical.js";
import { HARD_LIMITS, OperationSchema, type ErrorResult, type EngineResult, type Operation } from "../core/contracts.js";
import { EngineError, errorResult, timeoutResult } from "../core/errors.js";
import { executeOperation } from "./compute-pool.js";

const ROUTES: Record<string, Operation> = {
  "/v1/validate": "validate",
  "/v1/resolve": "resolve",
  "/v1/impact": "impact",
  "/v1/slice": "slice",
  "/v1/explain": "explain",
};

function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    throw new EngineError("TIMEOUT", "Reading the request body exceeded the wall-clock limit.");
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new EngineError("TIMEOUT", "Reading the request body exceeded the wall-clock limit."));
    }, remaining);
    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function readBodyBounded(request: Request, startedAt: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await readWithDeadline(reader, startedAt + HARD_LIMITS.maxTimeoutMs);
      if (done) {
        completed = true;
        break;
      }
      const nextTotal = total + value.byteLength;
      if (nextTotal > HARD_LIMITS.maxRequestBytes) {
        throw new EngineError(
          "REQUEST_TOO_LARGE",
          `Request exceeds ${HARD_LIMITS.maxRequestBytes} bytes.`,
          { actual_bytes: nextTotal, max_request_bytes: HARD_LIMITS.maxRequestBytes },
        );
      }
      chunks.push(value);
      total = nextTotal;
    }
  } finally {
    if (!completed) {
      void reader.cancel().catch(() => {
        // The original read error remains authoritative.
      });
    } else {
      reader.releaseLock();
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function statusForError(code: string): number {
  if (code === "REQUEST_TOO_LARGE" || code === "RESPONSE_TOO_LARGE") return 413;
  if (code === "DEPENDENCY_CYCLE") return 409;
  if (code === "TIMEOUT") return 408;
  if (code === "SERVER_BUSY") return 503;
  if (code === "INTERNAL_ERROR") return 500;
  return 400;
}

function httpError(code: string, message: string): ErrorResult {
  return { status: "error", error: { code, message } };
}

export async function handleHttpRequest(request: Request, startedAt = performance.now()): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    if (request.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (request.method === "GET") {
      return json({ status: "ok", service: "dependency-engine" });
    }
    return json(httpError("METHOD_NOT_ALLOWED", "Health requires GET or HEAD."), 405, { allow: "GET, HEAD" });
  }
  const operationValue = ROUTES[url.pathname];
  const parsedOperation = OperationSchema.safeParse(operationValue);
  if (!parsedOperation.success) {
    return json(httpError("NOT_FOUND", "Use POST /v1/validate, /resolve, /impact, /slice, or /explain."), 404);
  }
  if (request.method !== "POST") {
    return json(httpError("METHOD_NOT_ALLOWED", "Dependency operations require POST."), 405, { allow: "POST" });
  }
  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return json(httpError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json."), 415);
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > HARD_LIMITS.maxRequestBytes) {
    return json(httpError("REQUEST_TOO_LARGE", `Request exceeds ${HARD_LIMITS.maxRequestBytes} bytes.`), 413);
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBodyBounded(request, startedAt);
  } catch (error) {
    if (error instanceof EngineError) {
      return json(errorResult(error), statusForError(error.code));
    }
    return json(httpError("INVALID_BODY", "The request body could not be read."), 400);
  }
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json(httpError("INVALID_JSON", "The request body is not valid JSON."), 400);
  }
  // Slow or pathological requests run in isolated compute children so they
  // cannot block every other request on this server's event loop. The request
  // is serialized exactly once here for both routing and the core's size limit.
  let result: EngineResult = await executeOperation(
    parsedOperation.data,
    input,
    startedAt,
    byteLength(input),
  );
  if (deadlineExceeded(input, startedAt)) {
    result = timeoutResult(responseLimitFromInput(input));
  }
  const status = result.status === "error" ? statusForError(result.error.code) : 200;
  // A mechanical retry hint for the only status an agent client can safely retry.
  return json(result, status, status === 503 ? { "retry-after": "1" } : {});
}

export default {
  fetch: handleHttpRequest,
};
