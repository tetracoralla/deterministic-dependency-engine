import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DependencyGraph } from "../src/core/contracts.js";
import { GraphSphere } from "../src/ui/components/GraphSphere.js";
import { MAX_FOCUS_OPTIONS, searchFocusNodes } from "../src/ui/components/SphereFocusPicker.js";
import { createSphereModel, MAX_OVERVIEW_RELATIONS, rotateSphereVector } from "../src/ui/sphere-layout.js";
import { findHitNode, type ProjectedSphereNode } from "../src/ui/sphere-renderer.js";

const GRAPH: DependencyGraph = {
  schema: "agent-deps/v1",
  nodes: [
    { id: "release", label: "Release" },
    { id: "schema", label: "Schema" },
    { id: "backend", label: "Backend" },
  ],
  requires: [
    { dependent: "release", prerequisite: "backend" },
    { dependent: "backend", prerequisite: "schema" },
  ],
};

describe("dependency sphere layout", () => {
  it("maps execution layers to deterministic latitude bands", () => {
    const layers = [["schema"], ["backend"], ["release"]];
    const first = createSphereModel(GRAPH, layers);
    const shuffled = createSphereModel({
      ...GRAPH,
      nodes: [...GRAPH.nodes].reverse(),
      requires: [...GRAPH.requires].reverse(),
    }, layers);

    expect(shuffled).toEqual(first);
    const byId = new Map(first.nodes.map((node) => [node.id, node.position]));
    expect(byId.get("schema")?.y).toBeGreaterThan(byId.get("backend")?.y ?? 0);
    expect(byId.get("backend")?.y).toBeGreaterThan(byId.get("release")?.y ?? 0);
    for (const node of first.nodes) {
      expect(Math.hypot(node.position.x, node.position.y, node.position.z)).toBeCloseTo(1, 10);
    }
  });

  it("uses a finite deterministic fallback when no topological layers exist", () => {
    const first = createSphereModel(GRAPH, null);
    const second = createSphereModel(GRAPH, null);
    expect(second).toEqual(first);
    for (const node of first.nodes) {
      expect(Object.values(node.position).every(Number.isFinite)).toBe(true);
    }
  });

  it("suppresses a dense overview without discarding declared relation count", () => {
    const relations = Array.from({ length: MAX_OVERVIEW_RELATIONS + 1 }, () => ({
      dependent: "release",
      prerequisite: "schema",
    }));
    const model = createSphereModel({ ...GRAPH, requires: relations }, null);
    expect(model.relationCount).toBe(MAX_OVERVIEW_RELATIONS + 1);
    expect(model.showOverviewRelations).toBe(false);
    expect(model.relations).toHaveLength(MAX_OVERVIEW_RELATIONS + 1);
  });

  it("indexes direct relations once for selected-node rendering", () => {
    const model = createSphereModel(GRAPH, null);
    expect(model.relationsByNode.get("schema")).toEqual([
      { dependent: "backend", prerequisite: "schema" },
    ]);
    expect(model.relationsByNode.get("backend")).toEqual([
      { dependent: "release", prerequisite: "backend" },
      { dependent: "backend", prerequisite: "schema" },
    ]);
    expect(model.nodeById.get("release")?.label).toBe("Release");
  });

  it("rotates three-dimensional coordinates without changing their magnitude", () => {
    const rotated = rotateSphereVector({ x: 1, y: 0, z: 0 }, Math.PI / 2, Math.PI / 4);
    expect(rotated.x).toBeCloseTo(0, 10);
    expect(Math.hypot(rotated.x, rotated.y, rotated.z)).toBeCloseTo(1, 10);
    expect(rotated.z).toBeLessThan(0);
  });
});

describe("dependency sphere controls", () => {
  it("provides keyboard, focus, zoom, reset, and canvas alternatives", () => {
    const markup = renderToStaticMarkup(createElement(GraphSphere, {
      graph: GRAPH,
      executionLayers: [["schema"], ["backend"], ["release"]],
      issueCount: 0,
      error: null,
    }));

    expect(markup).toContain(">Focus</span>");
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("<select");
    expect(markup).toContain('aria-label="Zoom out"');
    expect(markup).toContain('aria-label="Zoom in"');
    expect(markup).toContain(">Reset</button>");
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("Use arrow keys to rotate");
    expect(markup).not.toContain("camera_position");
    expect(markup).not.toContain("scene_graph");
  });

  it("bounds focus results and ranks an exact opaque id first", () => {
    const nodes = Array.from({ length: 100 }, (_, index) => ({
      id: `node-${String(index).padStart(3, "0")}`,
      label: index === 73 ? "Shared label" : `Node ${index}`,
      position: { x: 0, y: 0, z: 1 },
    }));
    const broad = searchFocusNodes(nodes, "node");
    const exact = searchFocusNodes(nodes, "node-073");

    expect(broad.total).toBe(100);
    expect(broad.matches).toHaveLength(MAX_FOCUS_OPTIONS - 1);
    expect(exact.matches[0]?.id).toBe("node-073");
  });

  it("selects the frontmost overlapping point without sorting the projection", () => {
    const projected = [
      { id: "back", label: "Back", position: { x: 0, y: 0, z: 1 }, screenX: 20, screenY: 20, depth: -0.2, radius: 5 },
      { id: "front", label: "Front", position: { x: 0, y: 0, z: 1 }, screenX: 22, screenY: 20, depth: 0.8, radius: 5 },
    ] satisfies ProjectedSphereNode[];

    expect(findHitNode(projected, 20, 20)?.id).toBe("front");
    expect(findHitNode(projected, 100, 100)).toBeNull();
  });

  it("keeps invalid source recoverable without mounting a canvas", () => {
    const markup = renderToStaticMarkup(createElement(GraphSphere, {
      graph: null,
      executionLayers: null,
      issueCount: 0,
      error: "Fix the JSON syntax to open the sphere.",
    }));
    expect(markup).toContain("Sphere unavailable");
    expect(markup).toContain("Fix the JSON syntax");
    expect(markup).not.toContain("<canvas");
  });
});
