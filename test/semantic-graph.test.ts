import { describe, expect, it } from "vitest";
import { sliceSemanticGraph } from "@openadam/graph-view-compiler/semantic";
import { dependencyGraphToSemanticGraph } from "../src/core/semantic-graph.js";
import type { DependencyGraph } from "../src/core/contracts.js";

const graph: DependencyGraph = {
  schema: "agent-deps/v1",
  nodes: [
    { id: "release", label: "Release" },
    { id: "schema", label: "Schema" },
    { id: "build", label: "Build" },
  ],
  requires: [
    { dependent: "release", prerequisite: "build" },
    { dependent: "build", prerequisite: "schema" },
  ],
};

describe("Dependency Engine semantic graph adapter", () => {
  it("preserves prerequisite and dependent roles before Sphere projection", () => {
    const semantic = dependencyGraphToSemanticGraph(graph);
    expect(semantic.relations).toEqual([
      expect.objectContaining({ source: "build", target: "release", direction: "directed" }),
      expect.objectContaining({ source: "schema", target: "build", direction: "directed" }),
    ]);
    expect(sliceSemanticGraph(semantic, {
      focus: ["schema"],
      direction: "outgoing",
    }).nodes.map((node) => node.id)).toEqual(["build", "release", "schema"]);
  });

  it("keeps engine schema, query facts, receipts, and Sphere coordinates outside the shared graph", () => {
    const text = JSON.stringify(dependencyGraphToSemanticGraph(graph));
    expect(text).not.toContain("agent-deps/v1");
    expect(text).not.toContain("receipt");
    expect(text).not.toContain("position");
  });
});
