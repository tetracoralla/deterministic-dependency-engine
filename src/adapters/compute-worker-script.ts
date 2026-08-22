import { runMeasuredOperation } from "../core/engine.js";
import type { EngineResult, Operation } from "../core/contracts.js";

interface ComputeWorkerMessage {
  id: number;
  operation: Operation;
  input: unknown;
  /** Canonical serialized request size, so the child never re-serializes it. */
  requestBytes: number;
  /** Milliseconds already consumed before dispatch; wall clocks differ between processes. */
  elapsedMs: number;
}

interface ComputeWorkerReply {
  id: number;
  result: EngineResult;
}

process.on("message", (message: ComputeWorkerMessage) => {
  const reply: ComputeWorkerReply = {
    id: message.id,
    // performance.now() is process-local, so the deadline is anchored by the
    // elapsed parent time instead of the raw parent timestamp.
    result: runMeasuredOperation(
      message.operation,
      message.input,
      performance.now() - message.elapsedMs,
      message.requestBytes,
    ),
  };
  process.send?.(reply);
});

// A closed channel means the parent is gone; exit instead of finishing an
// orphaned calculation whose reply can never be delivered.
process.on("disconnect", () => process.exit(0));
