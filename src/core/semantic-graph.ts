import {
  SEMANTIC_GRAPH_VERSION,
  normalizeSemanticGraph,
  type SemanticGraphV1,
} from "@openadam/graph-view-compiler/semantic";
import { compareIds } from "./canonical.js";
import type { DependencyGraph } from "./contracts.js";

export function dependencyGraphToSemanticGraph(graph: DependencyGraph): SemanticGraphV1 {
  const relations = [...graph.requires].sort((left, right) =>
    compareIds(left.prerequisite, right.prerequisite) ||
    compareIds(left.dependent, right.dependent),
  );
  return normalizeSemanticGraph({
    version: SEMANTIC_GRAPH_VERSION,
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      ...(node.label === undefined ? {} : { label: node.label }),
      kind: "dependency",
    })),
    relations: relations.map((relation, index) => ({
      id: `requires:${String(index).padStart(8, "0")}`,
      source: relation.prerequisite,
      target: relation.dependent,
      direction: "directed",
      kind: "requires",
    })),
  });
}
