import { describe, expect, it } from "vitest";
import { runOperation } from "../src/core/engine.js";
import { presentResult } from "../src/core/presentation.js";

function starGraph(count: number) {
  const nodes = Array.from({ length: count }, (_, index) => ({ id: `node-${String(index).padStart(4, "0")}` }));
  nodes.push({ id: "target" });
  return {
    schema: "agent-deps/v1" as const,
    nodes,
    requires: nodes.slice(0, count).map((node) => ({ dependent: "target", prerequisite: node.id })),
  };
}

describe("presentation economy", () => {
  it("keeps the text rendering bounded for large node lists", () => {
    const result = runOperation("resolve", { graph: starGraph(1_600), targets: ["target"], satisfied: [] });
    expect(result.status).toBe("ok");
    const text = presentResult(result);
    expect(text).toContain("…and");
    expect(text).not.toContain("node-1599");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2_048);
  });

  it("still lists every node for small results", () => {
    const result = runOperation("resolve", {
      graph: {
        schema: "agent-deps/v1",
        nodes: [{ id: "a" }, { id: "b" }],
        requires: [{ dependent: "b", prerequisite: "a" }],
      },
      targets: ["b"],
      satisfied: [],
    });
    expect(result.status).toBe("ok");
    expect(presentResult(result)).toContain("Ready now: a.");
  });

  it("truncates long explanation paths", () => {
    const chain = Array.from({ length: 40 }, (_, index) => ({ id: `n${String(index).padStart(2, "0")}` }));
    const result = runOperation("explain", {
      graph: {
        schema: "agent-deps/v1",
        nodes: chain,
        requires: chain.slice(1).map((node, index) => ({ dependent: node.id, prerequisite: chain[index]?.id ?? node.id })),
      },
      kind: "impact",
      changed: "n00",
      affected: "n39",
    });
    expect(result.status).toBe("ok");
    const text = presentResult(result);
    expect(text).toContain("…(28 more)");
    expect(text).not.toContain("n39 ->");
  });
});
