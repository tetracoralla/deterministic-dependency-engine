import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DependencyGraph } from "../src/core/contracts.js";
import { GraphSphere } from "../src/ui/components/GraphSphere.js";
import { MAX_FOCUS_OPTIONS, searchFocusNodes } from "../src/ui/components/SphereFocusPicker.js";
import { createSphereModel, MAX_OVERVIEW_RELATIONS, rotateSphereVector, type SphereVector } from "../src/ui/sphere-layout.js";
import { SPHERE_INITIAL_CAMERA, SphereMotionController } from "../src/ui/sphere-motion.js";
import { drawSphere, findHitNode, projectSpherePoint, type ProjectedSphereNode } from "../src/ui/sphere-renderer.js";

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

describe("dependency sphere motion", () => {
  it("keeps a sub-threshold gesture as a click without moving the camera", () => {
    const motion = new SphereMotionController();
    motion.beginDrag(1, { x: 100, y: 100, time: 0 });

    expect(motion.updateDrag(1, { x: 103, y: 100, time: 16 })).toBe(false);
    expect(motion.endDrag(1, { x: 103, y: 100, time: 20 })).toBe("click");
    expect(motion.camera).toEqual(SPHERE_INITIAL_CAMERA);
  });

  it("continues a released drag with damped momentum before idle drift", () => {
    const motion = new SphereMotionController();
    motion.beginDrag(1, { x: 100, y: 100, time: 0 });
    expect(motion.updateDrag(1, { x: 140, y: 92, time: 32 })).toBe(true);
    const releasedYaw = motion.camera.yaw;

    expect(motion.endDrag(1, { x: 140, y: 92, time: 34 })).toBe("drag");
    expect(motion.hasInertia).toBe(true);
    expect(motion.advance(0.05, false)).toBe(true);
    expect(motion.camera.yaw).not.toBe(releasedYaw);

    for (let index = 0; index < 240; index += 1) motion.advance(0.05, true);
    expect(motion.hasInertia).toBe(false);
    const settledYaw = motion.camera.yaw;
    expect(motion.advance(0.1, true)).toBe(false);
    expect(motion.camera.yaw).toBe(settledYaw);
    expect(motion.advance(0.1, false)).toBe(true);
    expect(motion.camera.yaw).not.toBe(settledYaw);
  });

  it("keeps a short fast drag instead of snapping back", () => {
    const motion = new SphereMotionController();
    motion.beginDrag(3, { x: 80, y: 80, time: 0 });

    expect(motion.updateDrag(3, { x: 86, y: 81, time: 8 })).toBe(true);
    const releasedCamera = { ...motion.camera };
    expect(releasedCamera).not.toEqual(SPHERE_INITIAL_CAMERA);
    expect(motion.endDrag(3, { x: 86, y: 81, time: 10 })).toBe("drag");
    expect(motion.camera).toEqual(releasedCamera);
    expect(motion.hasInertia).toBe(true);
  });

  it("stops host-disabled motion without changing the visible camera", () => {
    const motion = new SphereMotionController();
    motion.beginDrag(4, { x: 10, y: 10, time: 0 });
    motion.updateDrag(4, { x: 50, y: 10, time: 20 });
    motion.endDrag(4, { x: 50, y: 10, time: 22 });
    const visibleCamera = { ...motion.camera };

    motion.stopMotion();
    expect(motion.hasInertia).toBe(false);
    expect(motion.camera).toEqual(visibleCamera);
    expect(motion.advance(0.1, true)).toBe(false);
    expect(motion.camera).toEqual(visibleCamera);
  });

  it("retains the last visible angle when a drag is cancelled", () => {
    const motion = new SphereMotionController();
    motion.beginDrag(7, { x: 20, y: 20, time: 0 });
    expect(motion.updateDrag(7, { x: 60, y: 32, time: 30 })).toBe(true);
    const visibleCamera = { ...motion.camera };

    expect(motion.cancelDrag()).toBe(true);
    expect(motion.camera).toEqual(visibleCamera);
    expect(motion.hasInertia).toBe(false);
    expect(motion.endDrag(7)).toBe("none");
  });
});

function recordingContext(): { context: CanvasRenderingContext2D; ops: string[] } {
  const ops: string[] = [];
  const gradient = { addColorStop: () => undefined };
  const context = {
    clearRect() { ops.push("clear"); },
    setTransform() { /* transform state is not compared */ },
    createRadialGradient: () => gradient,
    beginPath() { /* grouping only */ },
    arc(x: number, y: number, radius: number) { ops.push(`arc ${x.toFixed(4)} ${y.toFixed(4)} ${radius.toFixed(4)}`); },
    fill() { /* covered by the path ops above */ },
    stroke() { /* covered by the path ops above */ },
    moveTo(x: number, y: number) { ops.push(`move ${x.toFixed(4)} ${y.toFixed(4)}`); },
    lineTo(x: number, y: number) { ops.push(`line ${x.toFixed(4)} ${y.toFixed(4)}`); },
    closePath() { /* grouping only */ },
    fillRect(x: number, y: number, w: number, h: number) { ops.push(`rect ${x.toFixed(4)} ${y.toFixed(4)} ${w.toFixed(4)} ${h.toFixed(4)}`); },
    fillText(text: string, x: number, y: number) { ops.push(`text ${text} ${x.toFixed(4)} ${y.toFixed(4)}`); },
    measureText: () => ({ width: 10 }),
    fillStyle: null,
    strokeStyle: null,
    lineWidth: 0,
    font: "",
    textBaseline: "",
  } as unknown as CanvasRenderingContext2D;
  return { context, ops };
}

function drawOps(model: ReturnType<typeof createSphereModel>): string[] {
  const { context, ops } = recordingContext();
  drawSphere(context, model, 1280, 720, SPHERE_INITIAL_CAMERA, { selectedId: null, hoveredId: null });
  return ops;
}

describe("sphere renderer frame-cost refactor keeps output identical", () => {
  it("projects hoisted rotation identically to rotateSphereVector plus perspective", () => {
    const samples: SphereVector[] = [
      { x: 0, y: 0, z: 1 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: -0.577, y: 0.577, z: 0.577 },
      { x: 0.3, y: -0.8, z: 0.52 },
    ];
    const cameras = [SPHERE_INITIAL_CAMERA, { yaw: 2.1, pitch: 1.2, zoom: 1.3 }];
    for (const camera of cameras) {
      for (const point of samples) {
        const projected = projectSpherePoint(point, camera, 640, 360, 300);
        const rotated = rotateSphereVector(point, camera.yaw, camera.pitch);
        const perspective = 1 + rotated.z * 0.1;
        expect(projected.x).toBe(640 + rotated.x * 300 * perspective);
        expect(projected.y).toBe(360 - rotated.y * 300 * perspective);
        expect(projected.z).toBe(rotated.z);
      }
    }
  });

  it("renders equal models identically regardless of relation object identity or cache hits", () => {
    const graphB = JSON.parse(JSON.stringify(GRAPH)) as DependencyGraph;
    const modelA = createSphereModel(GRAPH, null);
    const modelB = createSphereModel(graphB, null);
    const first = drawOps(modelA);
    expect(drawOps(modelB)).toEqual(first);
    expect(drawOps(modelA)).toEqual(first);
    expect(first.some((op) => op.startsWith("move ") || op.startsWith("line "))).toBe(true);
  });

  it("does not reuse relation curves across models with different node positions", () => {
    const layers = [["schema"], ["backend"], ["release"]];
    const fallback = createSphereModel(GRAPH, null);
    const layeredWithSharedRelations = createSphereModel(GRAPH, layers);
    const layeredWithFreshRelations = createSphereModel(
      JSON.parse(JSON.stringify(GRAPH)) as DependencyGraph,
      layers,
    );

    drawOps(fallback);
    expect(drawOps(layeredWithSharedRelations)).toEqual(drawOps(layeredWithFreshRelations));
  });
});
