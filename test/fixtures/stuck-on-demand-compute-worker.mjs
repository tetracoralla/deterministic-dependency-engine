// Test fixture: a compute child that never answers jobs asked to hang
// (simulating a calculation that stopped checking its deadline) and answers
// every other job normally.
import { validResolution } from "./valid-result.mjs";

process.on("message", (message) => {
  if (message.input?.hang) return;
  process.send({ id: message.id, result: validResolution() });
});
