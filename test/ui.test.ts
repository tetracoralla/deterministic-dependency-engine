import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { runOperation } from "../src/core/engine.js";
import { App, parseGraphSource, parseNodeIds, queryEquals } from "../src/ui/App.js";
import { CodeEditor } from "../src/ui/components/CodeEditor.js";
import { QueryFields, type QueryState } from "../src/ui/components/QueryFields.js";
import { ResultView } from "../src/ui/components/ResultView.js";
import { safeGraphNodes } from "../src/ui/graph-data.js";
import { EXAMPLE_GRAPH } from "../src/ui/example.js";
import { HARD_LIMITS, PRODUCT_NAME } from "../src/core/contracts.js";

describe("UI graph input boundary", () => {
  it("keeps the workspace free of destructive example reset and detached status chrome", () => {
    const markup = renderToStaticMarkup(createElement(App));
    expect(markup).toContain(`<h1>${PRODUCT_NAME}</h1>`);
    expect(markup).not.toContain("Load example");
    expect(markup).not.toContain("<footer");
    expect(markup).toContain("5 nodes · 4 relations");
    expect(markup).toContain(">Run</button>");
    expect(markup).toContain('aria-label="Run: ');
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).not.toContain('role="tab"');
  });

  it("preserves source newlines in the syntax-highlighted overlay", () => {
    const source = "{\n  \"ready\": true\n}";
    const markup = renderToStaticMarkup(createElement(CodeEditor, { value: source, onChange: () => undefined }));
    const highlighted = markup.match(/<pre aria-hidden="true"[^>]*>([\s\S]*?)<\/pre>/u)?.[1];
    expect(highlighted).toBeDefined();
    expect(highlighted?.split("\n")).toHaveLength(3);
  });

  it("recognizes a query restored to the completed values", () => {
    const completed: QueryState = {
      targets: "release",
      satisfied: "schema, backend",
      changed: "backend",
      focus: "release",
      direction: "prerequisites",
      explanationKind: "blocked",
      affected: "release",
    };
    expect(queryEquals(completed, { ...completed, targets: "ui" })).toBe(false);
    expect(queryEquals(completed, { ...completed })).toBe(true);
  });

  it("does not reserve an empty query region for graph validation", () => {
    const state: QueryState = {
      targets: "release",
      satisfied: "",
      changed: "schema",
      focus: "release",
      direction: "prerequisites",
      explanationKind: "blocked",
      affected: "release",
    };
    expect(renderToStaticMarkup(createElement(QueryFields, {
      operation: "validate",
      state,
      onChange: () => undefined,
    }))).toBe("");
  });

  it("shows ready work once inside the execution order", () => {
    const result = runOperation("resolve", {
      graph: EXAMPLE_GRAPH,
      targets: ["release"],
      satisfied: ["schema", "backend"],
    });
    const markup = renderToStaticMarkup(createElement(ResultView, {
      result,
      labels: new Map(EXAMPLE_GRAPH.nodes.map((node) => [node.id, node.label ?? node.id])),
      stale: false,
      onCopy: () => undefined,
      copyState: "idle",
    }));
    expect(markup).not.toContain("Ready now");
    expect(markup).toContain(">Now</span>");
  });

  it("summarizes impact with no affected nodes as a result summary", () => {
    const result = runOperation("impact", { graph: EXAMPLE_GRAPH, changed: ["release"] });
    const markup = renderToStaticMarkup(createElement(ResultView, {
      result,
      labels: new Map(),
      stale: false,
      onCopy: () => undefined,
      copyState: "idle",
    }));
    expect(markup).toContain('<p class="result-summary">No affected nodes.</p>');
  });

  it("shows a cycle issue code, message, and witness", () => {
    const graph = {
      schema: "agent-deps/v1" as const,
      nodes: [{ id: "a" }, { id: "b" }],
      requires: [
        { dependent: "a", prerequisite: "b" },
        { dependent: "b", prerequisite: "a" },
      ],
    };
    const result = runOperation("validate", { graph });
    const markup = renderToStaticMarkup(createElement(ResultView, {
      result,
      labels: new Map(),
      stale: false,
      onCopy: () => undefined,
      copyState: "idle",
    }));
    expect(markup).toContain("DEPENDENCY_CYCLE");
    expect(markup).toContain("Dependency cycle:");
    expect(markup).toContain("a → b → a");
  });

  it("accepts one declared opaque id containing commas", () => {
    const graph = {
      schema: "agent-deps/v1",
      nodes: [{ id: "team,api" }, { id: "release" }],
      requires: [],
    };
    expect(parseNodeIds("team,api", graph)).toEqual(["team,api"]);
  });

  it("keeps ordinary comma-separated ids when no exact id exists", () => {
    const graph = {
      schema: "agent-deps/v1",
      nodes: [{ id: "team" }, { id: "api" }],
      requires: [],
    };
    expect(parseNodeIds("team, api", graph)).toEqual(["team", "api"]);
  });

  it("does not throw while structurally invalid JSON waits for core validation", () => {
    const malformed = { schema: "agent-deps/v1", nodes: {}, requires: [] };
    expect(safeGraphNodes(malformed)).toEqual([]);
    expect(parseNodeIds("release", malformed)).toEqual(["release"]);
  });

  it("rejects an oversized UTF-8 graph source before JSON parsing", () => {
    const source = `"${"界".repeat(Math.floor(HARD_LIMITS.maxRequestBytes / 3) + 1)}"`;
    const jsonParse = vi.spyOn(JSON, "parse");
    try {
      const parsed = parseGraphSource(source);
      expect(jsonParse).not.toHaveBeenCalled();
      expect(parsed).toMatchObject({ status: "error", code: "REQUEST_TOO_LARGE" });
      if (parsed.status === "error" && parsed.code === "REQUEST_TOO_LARGE") {
        expect(parsed.actualBytes).toBeGreaterThan(HARD_LIMITS.maxRequestBytes);
      }
    } finally {
      jsonParse.mockRestore();
    }
  });

  it("keeps example display names in declared graph data", () => {
    expect(EXAMPLE_GRAPH.nodes.map((node) => node.label)).toEqual([
      "Schema",
      "Backend",
      "UI",
      "E2E",
      "Release",
    ]);
  });
});
