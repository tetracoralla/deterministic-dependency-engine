import { describe, expect, it } from "vitest";
import { runOperation } from "../src/core/engine.js";
import { getCompiledGraph } from "../src/core/compiled-graph.js";
import type { DependencyGraph } from "../src/core/contracts.js";
import { cycleGraph, exampleGraph, shuffledGraph } from "./fixtures.js";

describe("dependency semantics", () => {
  it("resolves remaining work, ready nodes, layers, and blockers", () => {
    const result = runOperation("resolve", {
      graph: exampleGraph,
      targets: ["release"],
      satisfied: ["backend", "schema"],
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.kind !== "resolution") return;
    expect(result.required).toEqual(["schema", "ui", "backend", "e2e", "release"]);
    expect(result.remaining).toEqual(["ui", "e2e", "release"]);
    expect(result.ready).toEqual(["ui"]);
    expect(result.execution_layers).toEqual([["ui"], ["e2e"], ["release"]]);
    expect(result.blocked).toEqual([
      { node: "e2e", by: ["ui"] },
      { node: "release", by: ["e2e"] },
    ]);
    expect(result.root_blockers).toEqual(["ui"]);
  });

  it("does not report root blockers through already-satisfied targets", () => {
    const graph = {
      schema: "agent-deps/v1" as const,
      nodes: [{ id: "a" }, { id: "b" }],
      requires: [{ dependent: "b", prerequisite: "a" }],
    };
    const result = runOperation("resolve", { graph, targets: ["a", "b"], satisfied: ["b"] });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.kind !== "resolution") return;
    expect(result.remaining).toEqual(["a"]);
    expect(result.ready).toEqual(["a"]);
    expect(result.root_blockers).toEqual([]);
  });

  it("keeps a shared target that blocks another pending target as a root blocker", () => {
    const graph = {
      schema: "agent-deps/v1" as const,
      nodes: [{ id: "a" }, { id: "b" }],
      requires: [{ dependent: "b", prerequisite: "a" }],
    };
    const result = runOperation("resolve", { graph, targets: ["a", "b"], satisfied: [] });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.kind !== "resolution") return;
    expect(result.root_blockers).toEqual(["a"]);
  });

  it("does not cross a satisfied intermediate when relating separate targets", () => {
    const graph = {
      schema: "agent-deps/v1" as const,
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      requires: [
        { dependent: "b", prerequisite: "a" },
        { dependent: "c", prerequisite: "b" },
      ],
    };
    const result = runOperation("resolve", { graph, targets: ["a", "c"], satisfied: ["b"] });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.kind !== "resolution") return;
    expect(result.remaining).toEqual(["a", "c"]);
    expect(result.ready).toEqual(["a", "c"]);
    expect(result.root_blockers).toEqual([]);
  });

  it("treats satisfied nodes as completed subtrees while preserving structural required", () => {
    const graph = {
      schema: "agent-deps/v1" as const,
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      requires: [
        { dependent: "b", prerequisite: "a" },
        { dependent: "c", prerequisite: "b" },
      ],
    };
    const satisfiedTarget = runOperation("resolve", {
      graph,
      targets: ["c"],
      satisfied: ["c"],
    });
    expect(satisfiedTarget.status).toBe("ok");
    if (satisfiedTarget.status === "ok" && satisfiedTarget.kind === "resolution") {
      expect(satisfiedTarget.required).toEqual(["a", "b", "c"]);
      expect(satisfiedTarget.remaining).toEqual([]);
      expect(satisfiedTarget.ready).toEqual([]);
      expect(satisfiedTarget.execution_layers).toEqual([]);
      expect(satisfiedTarget.blocked).toEqual([]);
      expect(satisfiedTarget.root_blockers).toEqual([]);
    }

    const satisfiedIntermediate = runOperation("resolve", {
      graph,
      targets: ["c"],
      satisfied: ["b"],
    });
    expect(satisfiedIntermediate.status).toBe("ok");
    if (satisfiedIntermediate.status === "ok" && satisfiedIntermediate.kind === "resolution") {
      expect(satisfiedIntermediate.required).toEqual(["a", "b", "c"]);
      expect(satisfiedIntermediate.remaining).toEqual(["c"]);
      expect(satisfiedIntermediate.ready).toEqual(["c"]);
      expect(satisfiedIntermediate.execution_layers).toEqual([["c"]]);
      expect(satisfiedIntermediate.blocked).toEqual([]);
      expect(satisfiedIntermediate.root_blockers).toEqual([]);
    }

    const explanation = runOperation("explain", {
      graph,
      kind: "blocked",
      target: "c",
      satisfied: ["b"],
    });
    expect(explanation.status).toBe("ok");
    if (explanation.status === "ok" && explanation.kind === "blocked_explanation") {
      expect(explanation.blocked).toBe(false);
      expect(explanation.direct_blockers).toEqual([]);
      expect(explanation.root_blockers).toEqual([]);
      expect(explanation.paths).toEqual([]);
    }
  });

  it("reports direct and transitive downstream impact", () => {
    const result = runOperation("impact", { graph: exampleGraph, changed: ["schema"] });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.kind !== "impact") return;
    expect(result.direct).toEqual(["backend"]);
    expect(result.transitive).toEqual(["backend", "e2e", "release"]);
    expect(result.propagation_layers).toEqual([["backend"], ["e2e"], ["release"]]);
  });

  it("returns a minimal prerequisite slice", () => {
    const result = runOperation("slice", {
      graph: exampleGraph,
      focus: ["e2e"],
      direction: "prerequisites",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.kind !== "slice") return;
    expect(result.graph.nodes.map((node) => node.id)).toEqual(["backend", "e2e", "schema", "ui"]);
    expect(result.graph.requires).toHaveLength(3);
  });

  it("explains root blockers with deterministic paths", () => {
    const result = runOperation("explain", {
      graph: exampleGraph,
      kind: "blocked",
      target: "release",
      satisfied: ["schema", "backend"],
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.kind !== "blocked_explanation") return;
    expect(result.blocked).toBe(true);
    expect(result.direct_blockers).toEqual(["e2e"]);
    expect(result.root_blockers).toEqual(["ui"]);
    expect(result.paths).toEqual([["ui", "e2e", "release"]]);
  });

  it("explains every root blocker with one shortest path per root", () => {
    const graph = {
      schema: "agent-deps/v1" as const,
      nodes: [{ id: "r1" }, { id: "r2" }, { id: "r3" }, { id: "c1" }, { id: "c2a" }, { id: "c2b" }, { id: "target" }],
      requires: [
        { dependent: "c1", prerequisite: "r1" },
        { dependent: "c2a", prerequisite: "r2" },
        { dependent: "c2b", prerequisite: "c2a" },
        { dependent: "target", prerequisite: "c1" },
        { dependent: "target", prerequisite: "c2b" },
        { dependent: "target", prerequisite: "r3" },
      ],
    };
    const request = { graph, kind: "blocked" as const, target: "target", satisfied: [] };
    const result = runOperation("explain", request);
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.kind !== "blocked_explanation") return;
    expect(result.root_blockers).toEqual(["r1", "r2", "r3"]);
    expect(result.direct_blockers).toEqual(["c1", "c2b", "r3"]);
    expect(result.paths).toEqual([
      ["r1", "c1", "target"],
      ["r2", "c2a", "c2b", "target"],
      ["r3", "target"],
    ]);
    // Identical input must reproduce the identical complete result.
    expect(runOperation("explain", request)).toEqual(result);
  });

  it("preserves root-forward code-point ties for equal-length blocker paths", () => {
    // Two equal-length paths from root "r" to "target": r→a→y→target and
    // r→b→x→target. The optimized shared reverse traversal must still choose
    // the same root-forward path as the original per-root shortestPath call.
    const graph = {
      schema: "agent-deps/v1" as const,
      nodes: [{ id: "r" }, { id: "a" }, { id: "b" }, { id: "x" }, { id: "y" }, { id: "target" }],
      requires: [
        { dependent: "y", prerequisite: "a" },
        { dependent: "a", prerequisite: "r" },
        { dependent: "x", prerequisite: "b" },
        { dependent: "b", prerequisite: "r" },
        { dependent: "target", prerequisite: "y" },
        { dependent: "target", prerequisite: "x" },
      ],
    };
    const request = { graph, kind: "blocked" as const, target: "target", satisfied: [] };
    const result = runOperation("explain", request);
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.kind !== "blocked_explanation") return;
    expect(result.paths).toEqual([["r", "a", "y", "target"]]);
    // The tie rule is order-independent, like every canonical output.
    const shuffled = {
      ...request,
      graph: {
        schema: graph.schema,
        nodes: [...graph.nodes].reverse(),
        requires: [...graph.requires].reverse(),
      },
    };
    expect(runOperation("explain", shuffled)).toEqual(result);
  });

  it("does not explain a blocker through a satisfied branch", () => {
    const graph = {
      schema: "agent-deps/v1" as const,
      nodes: ["r", "s", "u1", "u2", "target"].map((id) => ({ id })),
      requires: [
        { dependent: "s", prerequisite: "r" },
        { dependent: "target", prerequisite: "s" },
        { dependent: "u1", prerequisite: "r" },
        { dependent: "u2", prerequisite: "u1" },
        { dependent: "target", prerequisite: "u2" },
      ],
    };
    const result = runOperation("explain", {
      graph,
      kind: "blocked",
      target: "target",
      satisfied: ["s"],
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.kind !== "blocked_explanation") return;
    expect(result.direct_blockers).toEqual(["u2"]);
    expect(result.root_blockers).toEqual(["r"]);
    expect(result.paths).toEqual([["r", "u1", "u2", "target"]]);
  });

  it("explains downstream reachability without inventing a path", () => {
    const reachable = runOperation("explain", {
      graph: exampleGraph,
      kind: "impact",
      changed: "schema",
      affected: "release",
    });
    const unreachable = runOperation("explain", {
      graph: exampleGraph,
      kind: "impact",
      changed: "ui",
      affected: "backend",
    });
    expect(reachable.status === "ok" && reachable.kind === "impact_explanation" ? reachable.path : null)
      .toEqual(["schema", "backend", "e2e", "release"]);
    expect(unreachable.status === "ok" && unreachable.kind === "impact_explanation" ? unreachable.path : [])
      .toBeNull();
  });
});

describe("validation and determinism", () => {
  it("returns real cycle components and witnesses", () => {
    const result = runOperation("validate", { graph: cycleGraph });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.kind !== "validation") return;
    expect(result.valid).toBe(false);
    expect(result.cycles).toEqual([{ component: ["a", "b", "c"], witness: ["a", "b", "c", "a"] }]);
    const edges = new Set(cycleGraph.requires.map((edge) => `${edge.prerequisite}->${edge.dependent}`));
    const witness = result.cycles[0]?.witness ?? [];
    for (let index = 0; index < witness.length - 1; index += 1) {
      expect(edges.has(`${witness[index]}->${witness[index + 1]}`)).toBe(true);
    }
  });

  it("does not let an unrelated cycle block target resolution", () => {
    const graph = {
      schema: "agent-deps/v1" as const,
      nodes: [...exampleGraph.nodes, { id: "x" }, { id: "y" }],
      requires: [
        ...exampleGraph.requires,
        { dependent: "x", prerequisite: "y" },
        { dependent: "y", prerequisite: "x" },
      ],
    };
    expect(runOperation("resolve", {
      graph,
      targets: ["release"],
      satisfied: ["schema", "backend"],
    }).status).toBe("ok");
  });

  it("rejects a cycle in the relevant target closure", () => {
    const result = runOperation("resolve", { graph: cycleGraph, targets: ["a"], satisfied: [] });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe("DEPENDENCY_CYCLE");
  });

  it("reports duplicate nodes, duplicate relations, and unknown endpoints", () => {
    const graph = {
      schema: "agent-deps/v1" as const,
      nodes: [{ id: "a" }, { id: "a" }],
      requires: [
        { dependent: "a", prerequisite: "missing" },
        { dependent: "a", prerequisite: "missing" },
      ],
    };
    const result = runOperation("validate", { graph });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.kind !== "validation") return;
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "DUPLICATE_NODE",
      "DUPLICATE_RELATION",
      "UNKNOWN_NODE",
      "UNKNOWN_NODE",
    ]);
  });

  it("produces identical results for shuffled graph and query arrays", () => {
    const baseline = runOperation("resolve", {
      graph: exampleGraph,
      targets: ["release"],
      satisfied: ["schema", "backend"],
    });
    for (let seed = 0; seed < 25; seed += 1) {
      const result = runOperation("resolve", {
        graph: shuffledGraph(seed),
        targets: ["release"],
        satisfied: seed % 2 === 0 ? ["backend", "schema"] : ["schema", "backend"],
      });
      expect(result).toEqual(baseline);
    }
  });

  it("uses Unicode code-point ordering rather than UTF-16 code-unit ordering", () => {
    const result = runOperation("validate", {
      graph: {
        schema: "agent-deps/v1",
        nodes: [{ id: "😀" }, { id: "\uE000" }],
        requires: [],
      },
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok" && result.kind === "validation") {
      expect(result.normalized_graph.nodes.map((node) => node.id)).toEqual(["\uE000", "😀"]);
    }
  });

  it("canonicalizes invalid duplicate nodes independently of input order", () => {
    const request = (nodes: Array<{ id: string; label: string }>) => runOperation("validate", {
      graph: {
        schema: "agent-deps/v1" as const,
        nodes,
        requires: [],
      },
    });
    const first = request([{ id: "a", label: "second" }, { id: "a", label: "first" }]);
    const second = request([{ id: "a", label: "first" }, { id: "a", label: "second" }]);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("compiled graph reuse", () => {
  it("reuses one compiled graph for identical declared content", () => {
    const first = getCompiledGraph(exampleGraph);
    const second = getCompiledGraph(structuredClone(exampleGraph));
    expect(second).toBe(first);
    expect(getCompiledGraph(cycleGraph)).not.toBe(first);
  });

  it("shares one compiled entry for graphs differing only by undefined fields", () => {
    // JSON.stringify drops undefined-valued fields, so both raw graphs produce
    // one cache key; the shared canonical copy must not carry the undefined
    // field of whichever caller compiled first.
    const withUndefined = {
      schema: "agent-deps/v1" as const,
      nodes: [{ id: "z", label: undefined }],
      requires: [],
    } as unknown as DependencyGraph;
    const without = {
      schema: "agent-deps/v1" as const,
      nodes: [{ id: "z" }],
      requires: [],
    } as unknown as DependencyGraph;
    const first = getCompiledGraph(withUndefined);
    expect(getCompiledGraph(without)).toBe(first);
    expect(Object.hasOwn(first.graph.nodes[0]!, "label")).toBe(false);
  });

  it("returns parsed result copies, never cached graph references", () => {
    const compiled = getCompiledGraph(exampleGraph);
    const result = runOperation("validate", { graph: exampleGraph });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.kind !== "validation") return;
    expect(result.normalized_graph).not.toBe(compiled.graph);
    // Mutating a returned result cannot poison later calls.
    result.normalized_graph.nodes.length = 0;
    const again = runOperation("validate", { graph: exampleGraph });
    expect(again.status).toBe("ok");
    if (again.status === "ok" && again.kind === "validation") {
      expect(again.normalized_graph.nodes).toHaveLength(exampleGraph.nodes.length);
    }
  });
});

describe("edge branches", () => {
  it("rejects query arrays that reference undeclared nodes", () => {
    const graph = {
      schema: "agent-deps/v1" as const,
      nodes: [{ id: "a" }],
      requires: [],
    };
    const result = runOperation("resolve", { graph, targets: ["ghost"], satisfied: [] });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("UNKNOWN_NODE");
      expect((result.error.details as { field?: string }).field).toBe("targets");
    }
  });

  it("reports a self-loop relation as a cycle with a two-node witness", () => {
    const graph = {
      schema: "agent-deps/v1" as const,
      nodes: [{ id: "a" }],
      requires: [{ dependent: "a", prerequisite: "a" }],
    };
    const result = runOperation("resolve", { graph, targets: ["a"], satisfied: [] });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("DEPENDENCY_CYCLE");
      const cycles = result.error.details as { cycles?: Array<{ witness?: string[] }> };
      expect(cycles.cycles?.[0]?.witness).toEqual(["a", "a"]);
    }
  });

  it("slices dependents and both directions", () => {
    const graph = {
      schema: "agent-deps/v1" as const,
      nodes: [{ id: "root" }, { id: "mid" }, { id: "leaf" }],
      requires: [
        { dependent: "mid", prerequisite: "root" },
        { dependent: "leaf", prerequisite: "mid" },
      ],
    };
    const dependents = runOperation("slice", { graph, focus: ["root"], direction: "dependents" });
    expect(dependents.status).toBe("ok");
    if (dependents.status === "ok" && dependents.kind === "slice") {
      expect(dependents.graph.nodes.map((node) => node.id)).toEqual(["leaf", "mid", "root"]);
    }
    const both = runOperation("slice", { graph, focus: ["mid"], direction: "both" });
    expect(both.status).toBe("ok");
    if (both.status === "ok" && both.kind === "slice") {
      expect(both.graph.nodes.map((node) => node.id)).toEqual(["leaf", "mid", "root"]);
    }
  });

  it("deduplicates repeated query ids in the canonical echo", () => {
    const graph = {
      schema: "agent-deps/v1" as const,
      nodes: [{ id: "a" }, { id: "b" }],
      requires: [{ dependent: "b", prerequisite: "a" }],
    };
    const result = runOperation("resolve", { graph, targets: ["b", "b", "a"], satisfied: [] });
    expect(result.status).toBe("ok");
    if (result.status === "ok" && result.kind === "resolution") {
      expect(result.targets).toEqual(["a", "b"]);
    }
  });

  it("rejects out-of-range execution limits as INVALID_REQUEST", () => {
    const result = runOperation("validate", {
      graph: exampleGraph,
      limits: { timeout_ms: 5 },
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe("INVALID_REQUEST");
  });

  it("reproduces identical receipt hashes for identical requests", () => {
    const request = { graph: exampleGraph, targets: ["release"], satisfied: [] };
    const first = runOperation("resolve", request);
    const second = runOperation("resolve", structuredClone(request));
    expect(second).toEqual(first);
    if (first.status === "ok" && second.status === "ok") {
      expect(second.receipt.graph_hash).toBe(first.receipt.graph_hash);
      expect(second.receipt.request_hash).toBe(first.receipt.request_hash);
      expect(second.receipt.result_hash).toBe(first.receipt.result_hash);
    }
  });
});
