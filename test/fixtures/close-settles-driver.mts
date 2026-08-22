// Test fixture driver: proves pool.close() settles even when the killed child
// and every idle handle are unref'd and nothing else holds the event loop.
import { fileURLToPath } from "node:url";
import { createComputePool } from "../../src/adapters/compute-pool.js";

const pool = createComputePool({
  workerUrl: fileURLToPath(new URL("./slow-compute-worker.mjs", import.meta.url)),
  maxWorkers: 1,
  maxPending: 1,
  watchdogMs: 10_000,
});

const result = await pool.execute("resolve", { delayMs: 50 }, performance.now(), 1_000_000);
if (result.status !== "ok") {
  throw new Error(`pooled job failed: ${JSON.stringify(result)}`);
}
await pool.close();
process.stdout.write("close-settled\n");
