// Test fixture: a compute child that answers after a configurable delay,
// standing in for a slow but healthy dependency calculation.
import { validResolution } from "./valid-result.mjs";

process.on("message", (message) => {
  const reply = () => process.send({
    id: message.id,
    result: validResolution(),
  });
  setTimeout(reply, message.input?.delayMs ?? 200);
});
