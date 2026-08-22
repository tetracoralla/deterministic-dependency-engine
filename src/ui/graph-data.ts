import type { DependencyNode } from "../core/contracts.js";

export function safeGraphNodes(graph: unknown): DependencyNode[] {
  if (graph === null || typeof graph !== "object") return [];
  const nodes = (graph as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.filter((node): node is DependencyNode => {
    if (node === null || typeof node !== "object") return false;
    const candidate = node as { id?: unknown; label?: unknown };
    return typeof candidate.id === "string" &&
      (candidate.label === undefined || typeof candidate.label === "string");
  });
}
