import {
  SEMANTIC_GRAPH_VERSION,
  normalizeSemanticGraph,
  type SemanticGraphV1,
} from "@openadam/graph-view-compiler/semantic";
import { compareIds } from "./canonical.js";
import type { DependencyGraph, DependencyNode } from "./contracts.js";

function declaredNodeCompare(left: DependencyNode, right: DependencyNode): number {
  return compareIds(left.id, right.id) || compareIds(left.label ?? "", right.label ?? "");
}

export function dependencyGraphToSemanticGraph(graph: DependencyGraph): SemanticGraphV1 {
  // A declared graph may carry structural issues (duplicate node ids,
  // relations naming undeclared nodes). The engine reports those as
  // validation issues while the sphere still opens with a fallback warning,
  // so the adapter projects the best-effort closed subset instead of letting
  // the shared strict boundary reject the whole projection. Duplicate ids
  // keep the first node in canonical (id, label) order so the projection
  // never depends on input array order.
  const declaredIds = new Set<string>();
  const nodes = [...graph.nodes]
    .sort(declaredNodeCompare)
    .filter((node) => {
      if (declaredIds.has(node.id)) return false;
      declaredIds.add(node.id);
      return true;
    })
    .map((node) => ({
      id: node.id,
      ...(node.label === undefined ? {} : { label: node.label }),
      kind: "dependency",
    }));
  const relations = graph.requires
    .filter((relation) =>
      declaredIds.has(relation.prerequisite) && declaredIds.has(relation.dependent))
    .sort((left, right) =>
      compareIds(left.prerequisite, right.prerequisite) ||
      compareIds(left.dependent, right.dependent))
    .map((relation, index) => ({
      id: `requires:${String(index).padStart(8, "0")}`,
      source: relation.prerequisite,
      target: relation.dependent,
      direction: "directed" as const,
      kind: "requires" as const,
    }));
  return normalizeSemanticGraph({
    version: SEMANTIC_GRAPH_VERSION,
    nodes,
    relations,
  });
}
