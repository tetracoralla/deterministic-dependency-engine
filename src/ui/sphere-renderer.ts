import type { SphereModel, SphereNode, SphereVector } from "./sphere-layout.js";
import { rotateSphereVector } from "./sphere-layout.js";
import type { SphereCamera } from "./sphere-motion.js";

export interface ProjectedSphereNode extends SphereNode {
  screenX: number;
  screenY: number;
  depth: number;
  radius: number;
}

export interface SphereRenderState {
  selectedId: string | null;
  hoveredId: string | null;
}

function projectVector(
  point: SphereVector,
  camera: SphereCamera,
  centerX: number,
  centerY: number,
  sphereRadius: number,
): { x: number; y: number; z: number } {
  const rotated = rotateSphereVector(point, camera.yaw, camera.pitch);
  const perspective = 1 + rotated.z * 0.1;
  return {
    x: centerX + rotated.x * sphereRadius * perspective,
    y: centerY - rotated.y * sphereRadius * perspective,
    z: rotated.z,
  };
}

function drawAmbientSpace(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  radius: number,
): void {
  const halo = context.createRadialGradient(centerX, centerY, radius * 0.1, centerX, centerY, radius * 1.16);
  halo.addColorStop(0, "rgb(78 160 145 / 7%)");
  halo.addColorStop(0.58, "rgb(57 116 107 / 4%)");
  halo.addColorStop(1, "rgb(15 18 18 / 0%)");
  context.fillStyle = halo;
  context.beginPath();
  context.arc(centerX, centerY, radius * 1.16, 0, Math.PI * 2);
  context.fill();
}

function surfaceCurve(from: SphereVector, to: SphereVector): SphereVector[] {
  const dot = Math.min(1, Math.max(-1, from.x * to.x + from.y * to.y + from.z * to.z));
  const angle = Math.acos(dot);
  const sine = Math.sin(angle);
  if (angle < 0.001 || Math.abs(sine) < 0.001) return [from, to];
  return Array.from({ length: 25 }, (_, index) => {
    const progress = index / 24;
    const fromWeight = Math.sin((1 - progress) * angle) / sine;
    const toWeight = Math.sin(progress * angle) / sine;
    return {
      x: from.x * fromWeight + to.x * toWeight,
      y: from.y * fromWeight + to.y * toWeight,
      z: from.z * fromWeight + to.z * toWeight,
    };
  });
}

function drawRelationCurve(
  context: CanvasRenderingContext2D,
  points: Array<{ x: number; y: number; z: number }>,
  selected: boolean,
): void {
  for (const front of [false, true]) {
    context.beginPath();
    let drawing = false;
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      if (previous === undefined || current === undefined) continue;
      const visible = front ? (previous.z + current.z) / 2 >= 0 : (previous.z + current.z) / 2 < 0;
      if (!visible) {
        drawing = false;
        continue;
      }
      if (!drawing) context.moveTo(previous.x, previous.y);
      context.lineTo(current.x, current.y);
      drawing = true;
    }
    context.strokeStyle = selected
      ? front ? "rgb(215 255 49 / 86%)" : "rgb(215 255 49 / 28%)"
      : front ? "rgb(179 216 207 / 44%)" : "rgb(112 143 137 / 13%)";
    context.lineWidth = selected ? (front ? 2 : 1.2) : (front ? 1.15 : 0.75);
    context.stroke();
  }
}

function drawArrowHead(
  context: CanvasRenderingContext2D,
  from: ProjectedSphereNode,
  to: ProjectedSphereNode,
): void {
  const angle = Math.atan2(to.screenY - from.screenY, to.screenX - from.screenX);
  const distance = Math.hypot(to.screenX - from.screenX, to.screenY - from.screenY);
  if (distance < 22) return;
  const tipX = to.screenX - Math.cos(angle) * (to.radius + 3);
  const tipY = to.screenY - Math.sin(angle) * (to.radius + 3);
  context.beginPath();
  context.moveTo(tipX, tipY);
  context.lineTo(tipX - Math.cos(angle - 0.5) * 6, tipY - Math.sin(angle - 0.5) * 6);
  context.lineTo(tipX - Math.cos(angle + 0.5) * 6, tipY - Math.sin(angle + 0.5) * 6);
  context.closePath();
  context.fill();
}

export function findHitNode(
  nodes: readonly ProjectedSphereNode[],
  x: number,
  y: number,
  padding = 7,
): ProjectedSphereNode | null {
  let match: ProjectedSphereNode | null = null;
  for (const node of nodes) {
    const deltaX = node.screenX - x;
    const deltaY = node.screenY - y;
    const hitRadius = node.radius + padding;
    if (deltaX * deltaX + deltaY * deltaY <= hitRadius * hitRadius && (match === null || node.depth > match.depth)) {
      match = node;
    }
  }
  return match;
}

export function drawSphere(
  context: CanvasRenderingContext2D,
  model: SphereModel,
  width: number,
  height: number,
  camera: SphereCamera,
  state: SphereRenderState,
): ProjectedSphereNode[] {
  context.clearRect(0, 0, width, height);
  const centerX = width / 2;
  const centerY = height / 2;
  const sphereRadius = Math.min(width, height) * 0.43 * camera.zoom;
  drawAmbientSpace(context, centerX, centerY, sphereRadius);

  const projectedNodes = model.nodes.map((node): ProjectedSphereNode => {
    const projected = projectVector(node.position, camera, centerX, centerY, sphereRadius);
    return {
      ...node,
      screenX: projected.x,
      screenY: projected.y,
      depth: projected.z,
      radius: Math.max(3.5, 5.2 + projected.z * 1.6) * Math.min(1.3, camera.zoom),
    };
  });
  const byId = new Map(projectedNodes.map((node) => [node.id, node]));
  const selectedRelations = state.selectedId === null
    ? []
    : model.relationsByNode.get(state.selectedId) ?? [];
  const relatedIds = new Set<string>();
  for (const relation of selectedRelations) {
    relatedIds.add(relation.prerequisite);
    relatedIds.add(relation.dependent);
  }
  const visibleRelations = model.showOverviewRelations || state.selectedId === null
    ? model.showOverviewRelations ? model.relations : []
    : selectedRelations;

  for (const relation of visibleRelations) {
    const prerequisite = byId.get(relation.prerequisite);
    const dependent = byId.get(relation.dependent);
    if (prerequisite === undefined || dependent === undefined) continue;
    const selectedRelation = state.selectedId !== null
      && (relation.prerequisite === state.selectedId || relation.dependent === state.selectedId);
    context.fillStyle = "rgb(215 255 49 / 82%)";
    const curve = surfaceCurve(prerequisite.position, dependent.position)
      .map((point) => projectVector(point, camera, centerX, centerY, sphereRadius));
    drawRelationCurve(context, curve, selectedRelation);
    if (selectedRelation) drawArrowHead(context, prerequisite, dependent);
  }

  const orderedNodes = [...projectedNodes].sort((left, right) => left.depth - right.depth);
  for (const node of orderedNodes) {
    const selected = node.id === state.selectedId;
    const hovered = node.id === state.hoveredId;
    const related = relatedIds.has(node.id);
    const frontAlpha = 0.54 + Math.max(-0.3, node.depth * 0.42);
    context.beginPath();
    context.arc(node.screenX, node.screenY, selected ? node.radius + 3 : hovered ? node.radius + 2 : node.radius, 0, Math.PI * 2);
    context.fillStyle = selected
      ? "#d7ff31"
      : related ? "#f0f5bd" : `rgb(188 219 209 / ${frontAlpha})`;
    context.fill();
    if (selected || hovered) {
      context.strokeStyle = selected ? "rgb(215 255 49 / 30%)" : "rgb(220 236 231 / 28%)";
      context.lineWidth = 5;
      context.stroke();
    }
  }

  const labels = orderedNodes.filter((node) => (
    node.id === state.selectedId
    || node.id === state.hoveredId
    || (model.nodes.length <= 12 && node.depth > -0.15)
  ));
  context.font = '500 12px Inter, ui-sans-serif, -apple-system, sans-serif';
  context.textBaseline = "middle";
  for (const node of labels) {
    const text = node.label.length > 24 ? `${node.label.slice(0, 23)}…` : node.label;
    const x = node.screenX + node.radius + 7;
    const metrics = context.measureText(text);
    context.fillStyle = "rgb(12 15 15 / 82%)";
    context.fillRect(x - 3, node.screenY - 9, metrics.width + 6, 18);
    context.fillStyle = node.id === state.selectedId ? "#d7ff31" : "#e4e9e6";
    context.fillText(text, x, node.screenY);
  }

  return projectedNodes;
}
