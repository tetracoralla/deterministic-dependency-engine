import { fork, type ChildProcess } from "node:child_process";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { responseLimitFromInput, timeoutFromInput } from "../core/budget.js";
import { byteLength } from "../core/canonical.js";
import { EngineResultSchema, HARD_LIMITS, type EngineResult, type Operation } from "../core/contracts.js";
import { runMeasuredOperation } from "../core/engine.js";
import { EngineError, errorResult, responseTooLargeResult, timeoutResult } from "../core/errors.js";

// Small requests are provably cheap (a bounded graph bounded by request bytes),
// so they run inline and keep single-request latency free of child-process
// round trips. Large requests—the only ones that can approach the deadline—run
// in killable child processes so one slow or pathological calculation can
// neither freeze every other request nor spend memory inside the server
// process itself.
export const INLINE_COMPUTE_MAX_BYTES = 32_768;

const DEFAULT_MAX_WORKERS = Math.max(1, Math.min(4, availableParallelism()));
const DEFAULT_MAX_PENDING = 128;
const DEFAULT_WATCHDOG_MS = HARD_LIMITS.maxTimeoutMs * 2 + 500;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_WORKER_MAX_OLD_SPACE_MB = 192;

interface PoolJob {
  id: number;
  operation: Operation;
  input: unknown;
  startedAt: number;
  /** Canonical serialized request size, forwarded so the child never re-serializes it. */
  requestBytes: number;
  /** Response limit selected by this request, used by every fallback envelope. */
  maxResponseBytes: number;
  /** Parent-process deadline covering queueing, dispatch, and worker execution. */
  deadlineAt: number;
  queueTimer: NodeJS.Timeout | null;
  resolve: (result: EngineResult) => void;
}

interface PoolChild {
  child: ChildProcess;
  job: PoolJob | null;
  watchdog: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  dead: boolean;
}

interface ChildExit {
  code?: number | null;
  signal?: string | null;
  spawnError?: string;
}

export interface ComputePoolOptions {
  workerUrl?: string;
  maxWorkers?: number;
  maxPending?: number;
  watchdogMs?: number;
  idleTimeoutMs?: number;
  workerMaxOldSpaceMb?: number;
}

export interface ComputePool {
  execute(operation: Operation, input: unknown, startedAt: number, requestBytes: number): Promise<EngineResult>;
  close(): Promise<void>;
}

function defaultWorkerUrl(): string {
  const self = fileURLToPath(import.meta.url);
  const extension = self.endsWith(".ts") ? "ts" : "js";
  return self.replace(/compute-pool\.[jt]s$/u, `compute-worker-script.${extension}`);
}

function workerExecArgv(workerUrl: string, workerMaxOldSpaceMb: number): string[] {
  // Development and tests run the TypeScript source via tsx; compiled
  // consumers always get plain JavaScript and no loader flag. Resolving the
  // loader relative to this module keeps pooled requests working regardless of
  // the process working directory.
  const memoryLimit = `--max-old-space-size=${workerMaxOldSpaceMb}`;
  if (!workerUrl.endsWith(".ts")) return [memoryLimit];
  try {
    return [memoryLimit, "--import", import.meta.resolve("tsx")];
  } catch {
    return [memoryLimit, "--import", "tsx"];
  }
}

export function createComputePool(options: ComputePoolOptions = {}): ComputePool {
  const workerUrl = options.workerUrl ?? defaultWorkerUrl();
  const maxWorkers = options.maxWorkers ?? DEFAULT_MAX_WORKERS;
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  const watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const workerMaxOldSpaceMb = options.workerMaxOldSpaceMb ?? DEFAULT_WORKER_MAX_OLD_SPACE_MB;

  let nextJobId = 1;
  let closed = false;
  const children: PoolChild[] = [];
  const pending: PoolJob[] = [];

  const serverBusy = (): EngineResult => errorResult(new EngineError(
    "SERVER_BUSY",
    "The engine is at capacity; retry once pending dependency calls complete.",
  ));

  // Shutdown is a capacity fact, not a deadline fact: in-flight, queued, and
  // post-close calls report SERVER_BUSY so callers retry against a live
  // server instead of misdiagnosing their own latency.
  const shuttingDown = (): EngineResult => errorResult(new EngineError(
    "SERVER_BUSY",
    "The engine is shutting down; retry once the server has restarted.",
  ));

  const workerCrashed = (exit: ChildExit): EngineResult => {
    const details: Record<string, unknown> = {};
    if (exit.spawnError !== undefined) details.spawn_error = exit.spawnError;
    else {
      details.exit_code = exit.code ?? null;
      details.exit_signal = exit.signal ?? null;
    }
    return errorResult(new EngineError(
      "INTERNAL_ERROR",
      "The dependency calculation worker failed unexpectedly.",
      details,
    ));
  };

  const workerProtocolFailure = (): EngineResult => errorResult(new EngineError(
    "INTERNAL_ERROR",
    "The dependency calculation worker returned an invalid response.",
  ));

  function resultMatchesOperation(result: EngineResult, operation: Operation): boolean {
    if (result.status === "error") return true;
    const expected = operation === "validate" ? result.kind === "validation"
      : operation === "resolve" ? result.kind === "resolution"
        : operation === "impact" ? result.kind === "impact"
          : operation === "slice" ? result.kind === "slice"
            : result.kind === "blocked_explanation" || result.kind === "impact_explanation";
    return expected && result.receipt.operation === operation;
  }

  function detach(entry: PoolChild): void {
    const index = children.indexOf(entry);
    if (index !== -1) children.splice(index, 1);
  }

  function clearEntryTimers(entry: PoolChild): void {
    if (entry.watchdog !== null) {
      clearTimeout(entry.watchdog);
      entry.watchdog = null;
    }
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  function retireWithResult(entry: PoolChild, result: EngineResult): void {
    if (entry.dead) return;
    entry.dead = true;
    clearEntryTimers(entry);
    detach(entry);
    entry.child.kill("SIGKILL");
    if (entry.job !== null) {
      entry.job.resolve(result);
      entry.job = null;
    }
    drain();
  }

  function crash(entry: PoolChild, exit: ChildExit = {}): void {
    if (entry.dead) return;
    entry.dead = true;
    clearEntryTimers(entry);
    detach(entry);
    if (entry.job !== null) {
      entry.job.resolve(workerCrashed(exit));
      entry.job = null;
    }
    drain();
  }

  function attach(entry: PoolChild, job: PoolJob): void {
    if (job.queueTimer !== null) {
      clearTimeout(job.queueTimer);
      job.queueTimer = null;
    }
    entry.job = job;
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    // An in-flight job must hold the process open even when nothing else
    // does; idle children release it again in scheduleIdleRecycle.
    entry.child.channel?.ref();
    const watchdogDelay = Math.max(0, Math.min(watchdogMs, job.deadlineAt - performance.now()));
    entry.watchdog = setTimeout(() => {
      // The in-child budget should fire first; this backstop removes a child
      // that stopped checking the deadline at all.
      retireWithResult(entry, timeoutResult(job.maxResponseBytes));
    }, watchdogDelay);
    try {
      entry.child.send({
        id: job.id,
        operation: job.operation,
        input: job.input,
        requestBytes: job.requestBytes,
        // performance.now() is process-local, so the child anchors its deadline
        // by the elapsed parent time instead of the raw timestamp.
        elapsedMs: Math.max(0, performance.now() - job.startedAt),
      });
    } catch {
      // A synchronously rejected send means the channel is already gone, and
      // the async failure events may never arrive for it.
      crash(entry);
    }
  }

  function scheduleIdleRecycle(entry: PoolChild): void {
    if (entry.idleTimer !== null) return;
    entry.idleTimer = setTimeout(() => {
      entry.dead = true;
      detach(entry);
      entry.child.kill();
    }, idleTimeoutMs);
    entry.idleTimer.unref();
    entry.child.channel?.unref();
  }

  function spawnChild(): PoolChild {
    const child = fork(workerUrl, {
      execArgv: workerExecArgv(workerUrl, workerMaxOldSpaceMb),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const entry: PoolChild = { child, job: null, watchdog: null, idleTimer: null, dead: false };
    // Idle children must not keep a resident MCP or HTTP server process alive.
    child.unref();
    child.channel?.unref();
    child.on("message", (reply: unknown) => {
      if (entry.dead) return;
      const job = entry.job;
      if (job === null) return;
      if (reply === null || typeof reply !== "object") {
        retireWithResult(entry, workerProtocolFailure());
        return;
      }
      const candidate = reply as { id?: unknown; result?: unknown };
      // Only a reply that completes the in-flight job may disarm the watchdog;
      // a mismatched reply must leave it armed so a broken worker cannot
      // strand the job and its worker slot forever.
      if (job.id !== candidate.id) return;
      if (performance.now() >= job.deadlineAt) {
        retireWithResult(entry, timeoutResult(job.maxResponseBytes));
        return;
      }
      const parsed = EngineResultSchema.safeParse(candidate.result);
      if (!parsed.success) {
        retireWithResult(entry, workerProtocolFailure());
        return;
      }
      // Zod has already deep-validated the wire value. The cast bridges its
      // exact-optional output inference to the hand-authored public interfaces.
      const result = parsed.data as EngineResult;
      if (!resultMatchesOperation(result, job.operation)) {
        retireWithResult(entry, workerProtocolFailure());
        return;
      }
      const actualBytes = byteLength(result);
      if (performance.now() >= job.deadlineAt) {
        retireWithResult(entry, timeoutResult(job.maxResponseBytes));
        return;
      }
      if (actualBytes > job.maxResponseBytes) {
        retireWithResult(entry, responseTooLargeResult(
          actualBytes,
          job.maxResponseBytes,
          result.status === "error" ? result.error.code : undefined,
        ));
        return;
      }
      if (entry.watchdog !== null) {
        clearTimeout(entry.watchdog);
        entry.watchdog = null;
      }
      entry.job = null;
      job.resolve(result);
      scheduleIdleRecycle(entry);
      drain();
    });
    // 'exit' is the authoritative termination event and the only one carrying
    // the child's exit code and signal, so it alone resolves an in-flight job
    // with real crash details. A disconnect from a still-running child does
    // not resolve anything: the job's watchdog bounds that wait, and the
    // imminent 'exit' delivers the details. 'error' covers spawn failures,
    // where 'exit' may never fire.
    child.on("error", (error: Error) => crash(entry, { spawnError: error.message.slice(0, 160) }));
    child.on("exit", (code, signal) => crash(entry, { code, signal }));
    children.push(entry);
    return entry;
  }

  function drain(): void {
    if (closed) return;
    while (pending.length > 0) {
      const idle = children.find((entry) => entry.job === null);
      if (idle === undefined) {
        if (children.length >= maxWorkers) break;
        spawnChild();
        continue;
      }
      const job = pending.shift();
      if (job === undefined) break;
      if (performance.now() >= job.deadlineAt) {
        if (job.queueTimer !== null) clearTimeout(job.queueTimer);
        job.queueTimer = null;
        job.resolve(timeoutResult(job.maxResponseBytes));
        continue;
      }
      attach(idle, job);
    }
  }

  function enqueue(job: PoolJob): void {
    const remaining = job.deadlineAt - performance.now();
    if (remaining <= 0) {
      job.resolve(timeoutResult(job.maxResponseBytes));
      return;
    }
    job.queueTimer = setTimeout(() => {
      job.queueTimer = null;
      const index = pending.indexOf(job);
      if (index === -1) return;
      pending.splice(index, 1);
      job.resolve(timeoutResult(job.maxResponseBytes));
    }, remaining);
    pending.push(job);
  }

  return {
    execute(operation, input, startedAt, requestBytes) {
      if (closed) return Promise.resolve(shuttingDown());
      return new Promise((resolve) => {
        const job: PoolJob = {
          id: nextJobId,
          operation,
          input,
          startedAt,
          requestBytes,
          maxResponseBytes: responseLimitFromInput(input),
          deadlineAt: startedAt + timeoutFromInput(input),
          queueTimer: null,
          resolve,
        };
        nextJobId += 1;
        if (performance.now() >= job.deadlineAt) {
          resolve(timeoutResult(job.maxResponseBytes));
          return;
        }
        const idle = children.find((entry) => entry.job === null);
        if (idle !== undefined) {
          attach(idle, job);
        } else if (children.length < maxWorkers) {
          attach(spawnChild(), job);
        } else if (pending.length < maxPending) {
          enqueue(job);
        } else {
          resolve(serverBusy());
        }
      });
    },
    async close() {
      closed = true;
      for (const job of pending.splice(0)) {
        if (job.queueTimer !== null) clearTimeout(job.queueTimer);
        job.queueTimer = null;
        job.resolve(shuttingDown());
      }
      const entries = children.splice(0);
      for (const entry of entries) {
        entry.dead = true;
        if (entry.watchdog !== null) clearTimeout(entry.watchdog);
        if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
        if (entry.job !== null) {
          entry.job.resolve(shuttingDown());
          entry.job = null;
        }
        entry.child.kill("SIGKILL");
        await new Promise<void>((resolveExit) => {
          // The fallback timer stays ref'd: close() must settle even when the
          // killed child and every other handle on the loop is unref'd.
          const timer = setTimeout(resolveExit, 1_000);
          entry.child.once("exit", () => {
            clearTimeout(timer);
            resolveExit();
          });
        });
      }
    },
  };
}

let sharedPool: ComputePool | undefined;

/** One pool per process, shared by the MCP and HTTP adapters. */
export function ensureSharedPool(): ComputePool {
  if (sharedPool === undefined) sharedPool = createComputePool();
  return sharedPool;
}

export async function executeOperation(
  operation: Operation,
  input: unknown,
  startedAt: number,
  requestBytes: number,
): Promise<EngineResult> {
  if (requestBytes <= INLINE_COMPUTE_MAX_BYTES) {
    return runMeasuredOperation(operation, input, startedAt, requestBytes);
  }
  return ensureSharedPool().execute(operation, input, startedAt, requestBytes);
}
