// Test fixture: a compute child that violates the pool protocol on demand —
// crashing mid-job or replying with a mismatched id — and answers normally
// for every other job.
import { validResolution } from "./valid-result.mjs";

process.on("message", (message) => {
  const input = message.input ?? {};
  if (input.crash) {
    process.exit(3);
  }
  if (input.wrongId) {
    process.send({ id: message.id + 999, result: validResolution() });
    return;
  }
  if (input.invalidResult) {
    process.send({ id: message.id, result: { status: "ok", kind: "resolution" } });
    return;
  }
  if (input.wrongOperation) {
    const result = validResolution();
    result.receipt.operation = "impact";
    process.send({ id: message.id, result });
    return;
  }
  if (input.oversizedResult) {
    process.send({
      id: message.id,
      result: {
        status: "error",
        error: { code: "FIXTURE_ERROR", message: "Oversized fixture response.", details: "x".repeat(2_000) },
      },
    });
    return;
  }
  process.send({ id: message.id, result: validResolution() });
});
