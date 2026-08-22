import { describe, expect, it } from "vitest";
import { HARD_LIMITS } from "../src/core/contracts.js";
import { runOperation } from "../src/core/engine.js";
import * as publicApi from "../src/index.js";
import { exampleGraph } from "./fixtures.js";

describe("execution boundary", () => {
  it("rejects unknown request fields before execution", () => {
    const result = runOperation("resolve", {
      graph: exampleGraph,
      targets: ["release"],
      satisfied: [],
      invented: true,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe("INVALID_REQUEST");
  });

  it("rejects ambiguous from/to relations", () => {
    const result = runOperation("validate", {
      graph: {
        schema: "agent-deps/v1",
        nodes: [{ id: "a" }, { id: "b" }],
        requires: [{ from: "a", to: "b" }],
      },
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe("INVALID_REQUEST");
  });

  it("truncates GRAPH_INVALID issues at 32 while reporting the full count", () => {
    const requires = Array.from({ length: 40 }, () => ({ dependent: "a", prerequisite: "b" }));
    const result = runOperation("resolve", {
      graph: {
        schema: "agent-deps/v1",
        nodes: [{ id: "a" }, { id: "b" }],
        requires,
      },
      targets: ["a"],
      satisfied: [],
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error.code).toBe("GRAPH_INVALID");
    const details = result.error.details as { issues?: unknown[]; issue_count?: number };
    expect(details.issues).toHaveLength(32);
    expect(details.issue_count).toBe(39);
  });

  it("bounds the complete response envelope", () => {
    const nodes = Array.from({ length: 140 }, (_, index) => ({ id: `node-${String(index).padStart(3, "0")}` }));
    const graph = {
      schema: "agent-deps/v1" as const,
      nodes,
      requires: nodes.slice(1).map((node, index) => ({
        dependent: node.id,
        prerequisite: nodes[index]?.id ?? "",
      })),
    };
    const result = runOperation("slice", {
      graph,
      focus: [nodes.at(-1)?.id],
      direction: "prerequisites",
      limits: { max_response_bytes: 1_024 },
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe("RESPONSE_TOO_LARGE");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1_024);
  });

  it("bounds structural-validation error responses", () => {
    const nodes = Array.from({ length: 32 }, (_, index) => ({ id: `node-${index}` }));
    const result = runOperation("resolve", {
      graph: {
        schema: "agent-deps/v1",
        nodes,
        requires: nodes.map((node, index) => ({
          dependent: node.id,
          prerequisite: `missing-${index}-${"x".repeat(80)}`,
        })),
      },
      targets: ["node-0"],
      satisfied: [],
      limits: { max_response_bytes: 1_024 },
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe("RESPONSE_TOO_LARGE");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1_024);
  });

  it("handles the maximum-depth acyclic chain without recursive stack overflow", () => {
    const nodes = Array.from({ length: HARD_LIMITS.maxNodes }, (_, index) => ({ id: `n${index}` }));
    const result = runOperation("validate", {
      graph: {
        schema: "agent-deps/v1",
        nodes,
        requires: nodes.slice(1).map((node, index) => ({
          dependent: node.id,
          prerequisite: nodes[index]?.id ?? "",
        })),
      },
    });
    expect(result.status === "error" ? result.error.code : "ok").not.toBe("INTERNAL_ERROR");
  });

  it("fails fast on blocker-path amplification instead of materializing it first", () => {
    // A legal request near the byte ceiling: thousands of root blockers whose
    // shortest paths to the target multiply far past the response limit.
    const roots = Array.from({ length: 3_000 }, (_, index) => ({ id: `r${String(index).padStart(4, "0")}` }));
    const chain = Array.from({ length: 900 }, (_, index) => ({ id: `c${String(index).padStart(4, "0")}` }));
    const nodes = [...roots, ...chain, { id: "target" }];
    const requires = [
      ...roots.map((node) => ({ dependent: "c0000", prerequisite: node.id })),
      ...chain.map((node, index) => ({
        dependent: index === chain.length - 1 ? "target" : `c${String(index + 1).padStart(4, "0")}`,
        prerequisite: node.id,
      })),
    ];
    const request = {
      graph: { schema: "agent-deps/v1" as const, nodes, requires },
    };
    const totalBytes = Buffer.byteLength(JSON.stringify({
      graph: request.graph,
      kind: "blocked",
      target: "target",
      satisfied: [],
    }));
    expect(totalBytes).toBeLessThanOrEqual(HARD_LIMITS.maxRequestBytes);

    const startedAt = performance.now();
    const result = runOperation("explain", { ...request, kind: "blocked", target: "target", satisfied: [] });
    const elapsedMs = performance.now() - startedAt;
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("RESPONSE_TOO_LARGE");
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(HARD_LIMITS.maxResponseBytes);
    }
    // Building every amplified path first and checking size last costs seconds;
    // the incremental response budget must reject within a small fraction.
    expect(elapsedMs).toBeLessThan(500);
  });

  it("counts elapsed time from logical call entry", () => {
    const result = runOperation("validate", {
      graph: exampleGraph,
      limits: { timeout_ms: 10 },
    }, performance.now() - 20);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe("TIMEOUT");
  });

  it("checks request bytes before structural validation", () => {
    const result = runOperation("validate", {
      graph: exampleGraph,
      padding: "x".repeat(HARD_LIMITS.maxRequestBytes),
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe("REQUEST_TOO_LARGE");
  });

  it("does not let public library callers forge the request-size measurement", () => {
    const input = {
      graph: {
        schema: "agent-deps/v1" as const,
        nodes: Array.from({ length: 2_000 }, (_, index) => ({
          id: `n${index}`,
          label: "x".repeat(256),
        })),
        requires: [],
      },
    };
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(HARD_LIMITS.maxRequestBytes);
    // Extra JavaScript arguments are ignored by the public three-argument API;
    // callers cannot replace the core's own byte measurement with a forged one.
    const callWithForgedFourthArgument = runOperation as unknown as (
      operation: "validate",
      value: unknown,
      startedAt: number,
      forgedBytes: number,
    ) => ReturnType<typeof runOperation>;
    const result = callWithForgedFourthArgument("validate", input, performance.now(), 1);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe("REQUEST_TOO_LARGE");
    expect("runMeasuredOperation" in publicApi).toBe(false);
  });

  it("recovers cleanly after an invalid request", () => {
    expect(runOperation("resolve", { nope: true }).status).toBe("error");
    const recovered = runOperation("resolve", {
      graph: exampleGraph,
      targets: ["release"],
      satisfied: ["schema", "backend"],
    });
    expect(recovered.status).toBe("ok");
  });
});
