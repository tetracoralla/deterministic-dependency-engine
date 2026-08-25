import { compareIds } from "../core/canonical.js";
import type { DependencyGraph, DependencyRelation } from "../core/contracts.js";

export interface SphereVector {
  x: number;
  y: number;
  z: number;
}

export interface SphereNode {
  id: string;
  label: string;
  position: SphereVector;
}

export interface SphereModel {
  nodes: SphereNode[];
  nodeById: ReadonlyMap<string, SphereNode>;
  relations: DependencyRelation[];
  relationsByNode: ReadonlyMap<string, readonly DependencyRelation[]>;
  relationCount: number;
  showOverviewRelations: boolean;
}

export const MAX_OVERVIEW_RELATIONS = 1_500;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const LAYER_LATITUDE_LIMIT = 0.82;

function fibonacciPosition(index: number, count: number): SphereVector {
  if (count === 1) return { x: 0, y: 0, z: 1 };
  const y = 1 - 2 * ((index + 0.5) / count);
  const ringRadius = Math.sqrt(Math.max(0, 1 - y * y));
  const angle = index * GOLDEN_ANGLE;
  return {
    x: Math.cos(angle) * ringRadius,
    y,
    z: Math.sin(angle) * ringRadius,
  };
}

function layeredPosition(
  index: number,
  count: number,
  layer: number,
  layerCount: number,
): SphereVector {
  const y = layerCount === 1
    ? 0
    : LAYER_LATITUDE_LIMIT - (layer / (layerCount - 1)) * LAYER_LATITUDE_LIMIT * 2;
  const ringRadius = Math.sqrt(Math.max(0, 1 - y * y));
  const angle = (index / count) * Math.PI * 2 + layer * GOLDEN_ANGLE;
  return {
    x: Math.cos(angle) * ringRadius,
    y,
    z: Math.sin(angle) * ringRadius,
  };
}

function relationCompare(left: DependencyRelation, right: DependencyRelation): number {
  return compareIds(left.prerequisite, right.prerequisite)
    || compareIds(left.dependent, right.dependent);
}

export function createSphereModel(
  graph: DependencyGraph,
  executionLayers: readonly (readonly string[])[] | null,
): SphereModel {
  const declaredNodes = [...graph.nodes].sort((left, right) => compareIds(left.id, right.id));
  const knownIds = new Set(declaredNodes.map((node) => node.id));
  const layerById = new Map<string, { index: number; position: number; size: number }>();
  if (executionLayers !== null) {
    executionLayers.forEach((ids, layerIndex) => {
      const ordered = [...ids].sort(compareIds);
      ordered.forEach((id, position) => {
        layerById.set(id, { index: layerIndex, position, size: ordered.length });
      });
    });
  }

  const nodes = declaredNodes.map((node, index): SphereNode => {
    const layer = layerById.get(node.id);
    return {
      id: node.id,
      label: node.label ?? node.id,
      position: layer === undefined || executionLayers === null
        ? fibonacciPosition(index, declaredNodes.length)
        : layeredPosition(layer.position, layer.size, layer.index, executionLayers.length),
    };
  });
  const relations = graph.requires
    .filter((relation) => knownIds.has(relation.prerequisite) && knownIds.has(relation.dependent))
    .toSorted(relationCompare);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const relationsByNode = new Map<string, DependencyRelation[]>(nodes.map((node) => [node.id, []]));
  for (const relation of relations) {
    relationsByNode.get(relation.prerequisite)?.push(relation);
    if (relation.dependent !== relation.prerequisite) relationsByNode.get(relation.dependent)?.push(relation);
  }

  return {
    nodes,
    nodeById,
    relations,
    relationsByNode,
    relationCount: graph.requires.length,
    showOverviewRelations: relations.length <= MAX_OVERVIEW_RELATIONS,
  };
}

export function rotateSphereVector(
  point: SphereVector,
  yaw: number,
  pitch: number,
): SphereVector {
  const yawCos = Math.cos(yaw);
  const yawSin = Math.sin(yaw);
  const pitchCos = Math.cos(pitch);
  const pitchSin = Math.sin(pitch);
  const yawX = point.x * yawCos + point.z * yawSin;
  const yawZ = -point.x * yawSin + point.z * yawCos;
  return {
    x: yawX,
    y: point.y * pitchCos - yawZ * pitchSin,
    z: point.y * pitchSin + yawZ * pitchCos,
  };
}
