import type { EngineResult } from "./contracts.js";

/** Long lists are summarized so the text rendering stays a bounded-size summary. */
const MAX_LISTED = 12;

function list(values: string[]): string {
  if (values.length === 0) return "none";
  if (values.length <= MAX_LISTED) return values.join(", ");
  return `${values.slice(0, MAX_LISTED).join(", ")}, …and ${values.length - MAX_LISTED} more`;
}

function path(values: string[]): string {
  if (values.length <= MAX_LISTED) return values.join(" -> ");
  return `${values.slice(0, MAX_LISTED).join(" -> ")} -> …(${values.length - MAX_LISTED} more)`;
}

export function presentResult(result: EngineResult): string {
  if (result.status === "error") return `${result.error.code}: ${result.error.message}`;
  if (result.kind === "validation") {
    return result.valid
      ? `Valid dependency graph: ${result.node_count} nodes, ${result.relation_count} relations, ${result.execution_layers?.length ?? 0} execution layers.`
      : `Invalid dependency graph: ${result.issues.length} issue(s); cycles: ${result.cycles.map((cycle) => path(cycle.witness)).join("; ") || "none"}.`;
  }
  if (result.kind === "resolution") {
    return `Ready now: ${list(result.ready)}. Remaining: ${result.remaining.length} node(s) across ${result.execution_layers.length} layer(s). Root blockers: ${list(result.root_blockers)}.`;
  }
  if (result.kind === "impact") {
    return `Directly affected: ${list(result.direct)}. Transitively affected: ${list(result.transitive)}.`;
  }
  if (result.kind === "slice") {
    return `Dependency slice: ${result.graph.nodes.length} nodes and ${result.graph.requires.length} relations in ${result.direction} direction.`;
  }
  if (result.kind === "blocked_explanation") {
    return result.blocked
      ? `${result.target} is blocked by root node(s): ${list(result.root_blockers)}.`
      : `${result.target} is not blocked${result.satisfied ? " because it is satisfied" : " and is ready"}.`;
  }
  return result.reachable && result.path !== null
    ? `${result.changed} affects ${result.affected} through ${path(result.path)}.`
    : `${result.changed} does not affect ${result.affected} in the declared graph.`;
}
