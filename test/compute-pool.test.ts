import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createComputePool,
  executeOperation,
  type ComputePool,
} from "../src/adapters/compute-pool.js";
import { exampleGraph } from "./fixtures.js";

const SLOW_WORKER = resolve("test/fixtures/slow-compute-worker.mjs");
const STUCK_ON_DEMAND_WORKER = resolve("test/fixtures/stuck-on-demand-compute-worker.mjs");
const FLAKY_WORKER = resolve("test/fixtures/flaky-compute-worker.mjs");

const pools: ComputePool[] = [];

function trackedPool(workerUrl: string, options: Parameters<typeof createComputePool>[0]): ComputePool {
  const pool = createComputePool({ workerUrl, maxWorkers: 1, maxPending: 2, watchdogMs: 10_000, ...options });
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

function errorCode(result: unknown): string {
  const error = (result as { error?: { code?: string } }).error;
  return error?.code ?? "none";
}

describe("compute pool admission and isolation", () => {
  it("keeps inline calls independent of busy compute children", async () => {
    const pool = trackedPool(SLOW_WORKER, { maxWorkers: 1, maxPending: 8, watchdogMs: 10_000 });
    // The only child is occupied for 400ms.
    const slow = pool.execute("resolve", { delayMs: 400 }, performance.now(), 1_000_000);
    const inlineStartedAt = performance.now();
    // A small request runs inline and must not queue behind the busy child.
    const inline = await executeOperation(
      "resolve",
      { graph: exampleGraph, targets: ["release"], satisfied: ["schema", "backend"] },
      inlineStartedAt,
      512,
    );
    expect(performance.now() - inlineStartedAt).toBeLessThan(200);
    expect(inline.status).toBe("ok");
    const slowResult = await slow;
    expect(slowResult.status).toBe("ok");
  }, 15_000);

  it("rejects work beyond the bounded queue with a stable SERVER_BUSY", async () => {
    const pool = trackedPool(SLOW_WORKER, { maxWorkers: 1, maxPending: 1, watchdogMs: 10_000 });
    const first = pool.execute("resolve", { delayMs: 300, marker: "first" }, performance.now(), 1_000_000);
    const queued = pool.execute("resolve", { delayMs: 50, marker: "queued" }, performance.now(), 1_000_000);
    const busyStartedAt = performance.now();
    const rejected = await pool.execute("resolve", { marker: "overflow" }, performance.now(), 1_000_000);
    // Admission control answers immediately instead of queueing unboundedly.
    expect(performance.now() - busyStartedAt).toBeLessThan(200);
    expect(errorCode(rejected)).toBe("SERVER_BUSY");
    expect((await first).status).toBe("ok");
    expect((await queued).status).toBe("ok");
  }, 15_000);

  it("destroys and replaces a child that stops checking its deadline", async () => {
    const pool = trackedPool(STUCK_ON_DEMAND_WORKER, { maxWorkers: 1, maxPending: 4, watchdogMs: 300 });
    const stuckStartedAt = performance.now();
    const stuck = await pool.execute("resolve", { hang: true }, performance.now(), 1_000_000);
    // The watchdog, not the hung child, ends the call.
    expect(errorCode(stuck)).toBe("TIMEOUT");
    expect(performance.now() - stuckStartedAt).toBeGreaterThanOrEqual(250);
    expect(performance.now() - stuckStartedAt).toBeLessThan(3_000);
    // A replacement child serves the next call normally.
    const recovered = await pool.execute("resolve", {}, performance.now(), 1_000_000);
    expect(recovered.status).toBe("ok");
  }, 15_000);

  it("uses the selected logical deadline instead of the global watchdog maximum", async () => {
    const pool = trackedPool(STUCK_ON_DEMAND_WORKER, { maxWorkers: 1, maxPending: 1, watchdogMs: 10_000 });
    const startedAt = performance.now();
    const result = await pool.execute(
      "resolve",
      { hang: true, limits: { timeout_ms: 50 } },
      startedAt,
      1_000_000,
    );
    expect(errorCode(result)).toBe("TIMEOUT");
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    const recovered = await pool.execute("resolve", {}, performance.now(), 1_000_000);
    expect(recovered.status).toBe("ok");
  }, 15_000);

  it("expires queued work at its own logical deadline", async () => {
    const pool = trackedPool(SLOW_WORKER, { maxWorkers: 1, maxPending: 2, watchdogMs: 10_000 });
    const first = pool.execute("resolve", { delayMs: 300 }, performance.now(), 1_000_000);
    const queuedAt = performance.now();
    const queued = await pool.execute(
      "resolve",
      { delayMs: 10, limits: { timeout_ms: 50 } },
      queuedAt,
      1_000_000,
    );
    expect(errorCode(queued)).toBe("TIMEOUT");
    expect(performance.now() - queuedAt).toBeLessThan(1_000);
    expect((await first).status).toBe("ok");
  }, 15_000);

  it("recovers when a child crashes mid-job and reports bounded exit details", async () => {
    const pool = trackedPool(FLAKY_WORKER, { maxWorkers: 1, maxPending: 2, watchdogMs: 10_000 });
    const crashed = await pool.execute("resolve", { crash: true }, performance.now(), 1_000_000);
    expect(errorCode(crashed)).toBe("INTERNAL_ERROR");
    const details = (crashed as { error?: { details?: { exit_code?: number | null } } }).error?.details;
    expect(details?.exit_code).toBe(3);
    // A replacement child serves the next call normally.
    const recovered = await pool.execute("resolve", {}, performance.now(), 1_000_000);
    expect(recovered.status).toBe("ok");
  }, 15_000);

  it("rejects an invalid worker result before adapters can consume it", async () => {
    const pool = trackedPool(FLAKY_WORKER, { maxWorkers: 1, maxPending: 2, watchdogMs: 10_000 });
    const invalid = await pool.execute("resolve", { invalidResult: true }, performance.now(), 1_000_000);
    expect(errorCode(invalid)).toBe("INTERNAL_ERROR");
    const recovered = await pool.execute("resolve", {}, performance.now(), 1_000_000);
    expect(recovered.status).toBe("ok");
  }, 15_000);

  it("rejects a worker result whose receipt names another operation", async () => {
    const pool = trackedPool(FLAKY_WORKER, { maxWorkers: 1, maxPending: 2, watchdogMs: 10_000 });
    const mismatched = await pool.execute("resolve", { wrongOperation: true }, performance.now(), 1_000_000);
    expect(errorCode(mismatched)).toBe("INTERNAL_ERROR");
    expect((await pool.execute("resolve", {}, performance.now(), 1_000_000)).status).toBe("ok");
  }, 15_000);

  it("bounds a valid but oversized worker result at the parent boundary", async () => {
    const pool = trackedPool(FLAKY_WORKER, { maxWorkers: 1, maxPending: 2, watchdogMs: 10_000 });
    const oversized = await pool.execute(
      "resolve",
      { oversizedResult: true, limits: { max_response_bytes: 1_024 } },
      performance.now(),
      1_000_000,
    );
    expect(errorCode(oversized)).toBe("RESPONSE_TOO_LARGE");
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThanOrEqual(1_024);
    expect((await pool.execute("resolve", {}, performance.now(), 1_000_000)).status).toBe("ok");
  }, 15_000);

  it("keeps the watchdog armed when a child replies with a mismatched id", async () => {
    const pool = trackedPool(FLAKY_WORKER, { maxWorkers: 1, maxPending: 2, watchdogMs: 300 });
    const startedAt = performance.now();
    const stranded = await pool.execute("resolve", { wrongId: true }, performance.now(), 1_000_000);
    // The reply does not complete the job, so only the watchdog may end it;
    // disarming it on a mismatched id would strand the job and the slot forever.
    expect(errorCode(stranded)).toBe("TIMEOUT");
    expect(performance.now() - startedAt).toBeLessThan(3_000);
    const recovered = await pool.execute("resolve", {}, performance.now(), 1_000_000);
    expect(recovered.status).toBe("ok");
  }, 15_000);

  it("resolves in-flight and queued work as SERVER_BUSY when closing", async () => {
    const pool = trackedPool(SLOW_WORKER, { maxWorkers: 1, maxPending: 2, watchdogMs: 10_000 });
    const inFlight = pool.execute("resolve", { delayMs: 2_000 }, performance.now(), 1_000_000);
    const queued = pool.execute("resolve", { delayMs: 50 }, performance.now(), 1_000_000);
    await pool.close();
    // Shutdown is a capacity fact, not a deadline fact.
    expect(errorCode(await inFlight)).toBe("SERVER_BUSY");
    expect(errorCode(await queued)).toBe("SERVER_BUSY");
    // A closed pool answers immediately instead of accepting new work, and a
    // second close resolves without hanging.
    await expect(pool.close()).resolves.toBeUndefined();
    expect(errorCode(await pool.execute("resolve", {}, performance.now(), 1_000_000))).toBe("SERVER_BUSY");
  }, 15_000);

  it("settles close() in a bare process whose event loop holds nothing else", async () => {
    // The pool's own children and idle timers are unref'd by design; if the
    // close fallback timer were unref'd too, this driver would die with an
    // unsettled top-level await instead of exiting 0 after close returns.
    const driver = spawn(
      process.execPath,
      ["--import", "tsx", resolve("test/fixtures/close-settles-driver.mts")],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const outcome = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveOutcome) => {
      let stdout = "";
      let stderr = "";
      driver.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      driver.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      driver.once("exit", (code) => resolveOutcome({ code, stdout, stderr }));
    });
    const { code, stdout } = await outcome;
    expect(code).toBe(0);
    expect(stdout).toContain("close-settled");
  }, 30_000);
});
