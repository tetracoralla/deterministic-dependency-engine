import type {
  CycleDiagnostic,
  DependencyGraph,
  DependencyRelation,
  GraphIssue,
} from "./contracts.js";
import { compareIds, sortedUnique } from "./canonical.js";
import { ExecutionBudget } from "./budget.js";
import { EngineError } from "./errors.js";

export interface GraphIndex {
  graph: DependencyGraph;
  ids: string[];
  nodeById: Map<string, DependencyGraph["nodes"][number]>;
  prerequisites: Map<string, string[]>;
  dependents: Map<string, string[]>;
}

function relationKey(relation: DependencyRelation): string {
  return `${relation.dependent}\u0000${relation.prerequisite}`;
}

/** Detects declaration issues over a graph that is already in canonical form. */
export function findGraphIssues(graph: DependencyGraph): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({
        code: "DUPLICATE_NODE",
        message: `Node id ${JSON.stringify(node.id)} is declared more than once.`,
        nodes: [node.id],
      });
    }
    nodeIds.add(node.id);
  }

  const relations = new Set<string>();
  for (const relation of graph.requires) {
    const missing = [relation.dependent, relation.prerequisite].filter((id) => !nodeIds.has(id));
    if (missing.length > 0) {
      issues.push({
        code: "UNKNOWN_NODE",
        message: `Relation references undeclared node(s): ${sortedUnique(missing).join(", ")}.`,
        nodes: sortedUnique(missing),
        relation,
      });
    }
    const key = relationKey(relation);
    if (relations.has(key)) {
      issues.push({
        code: "DUPLICATE_RELATION",
        message: `${relation.dependent} requires ${relation.prerequisite} more than once.`,
        nodes: sortedUnique([relation.dependent, relation.prerequisite]),
        relation,
      });
    }
    relations.add(key);
  }

  issues.sort((left, right) => compareIds(left.code, right.code) ||
    compareIds(left.nodes.join("\u0000"), right.nodes.join("\u0000")));
  return issues;
}

/** Builds an index over a graph that already passed inspectGraph with no issues. */
export function buildGraphIndex(graph: DependencyGraph): GraphIndex {
  const ids = graph.nodes.map((node) => node.id);
  const prerequisites = new Map(ids.map((id) => [id, [] as string[]]));
  const dependents = new Map(ids.map((id) => [id, [] as string[]]));
  for (const relation of graph.requires) {
    prerequisites.get(relation.dependent)?.push(relation.prerequisite);
    dependents.get(relation.prerequisite)?.push(relation.dependent);
  }
  for (const values of [...prerequisites.values(), ...dependents.values()]) values.sort(compareIds);
  return {
    graph,
    ids,
    nodeById: new Map(graph.nodes.map((node) => [node.id, node])),
    prerequisites,
    dependents,
  };
}

export function assertKnownNodes(index: GraphIndex, values: Iterable<string>, field: string): string[] {
  const normalized = sortedUnique(values);
  const unknown = normalized.filter((id) => !index.nodeById.has(id));
  if (unknown.length > 0) {
    throw new EngineError("UNKNOWN_NODE", `${field} references undeclared node(s): ${unknown.join(", ")}.`, {
      field,
      nodes: unknown,
    });
  }
  return normalized;
}

export function closure(
  index: GraphIndex,
  starts: Iterable<string>,
  direction: "prerequisites" | "dependents",
  budget: ExecutionBudget,
  stopAt: ReadonlySet<string> = new Set<string>(),
): Set<string> {
  const visited = new Set<string>();
  const queue = sortedUnique(starts);
  const adjacency = direction === "prerequisites" ? index.prerequisites : index.dependents;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    if ((cursor & 255) === 0) budget.check();
    const current = queue[cursor];
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    if (stopAt.has(current)) continue;
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return visited;
}

export function stronglyConnectedComponents(
  index: GraphIndex,
  budget: ExecutionBudget,
  subset: Set<string> = new Set(index.ids),
): string[][] {
  const visited = new Set<string>();
  const finishOrder: string[] = [];
  const components: string[][] = [];

  for (const start of [...subset].sort(compareIds)) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack: Array<{ node: string; neighbors: string[]; cursor: number }> = [{
      node: start,
      neighbors: (index.dependents.get(start) ?? []).filter((node) => subset.has(node)),
      cursor: 0,
    }];
    while (stack.length > 0) {
      budget.check();
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;
      const next = frame.neighbors[frame.cursor];
      if (next !== undefined) {
        frame.cursor += 1;
        if (visited.has(next)) continue;
        visited.add(next);
        stack.push({
          node: next,
          neighbors: (index.dependents.get(next) ?? []).filter((node) => subset.has(node)),
          cursor: 0,
        });
        continue;
      }
      stack.pop();
      finishOrder.push(frame.node);
    }
  }

  const assigned = new Set<string>();
  for (let orderIndex = finishOrder.length - 1; orderIndex >= 0; orderIndex -= 1) {
    const start = finishOrder[orderIndex];
    if (start === undefined || assigned.has(start)) continue;
    const component: string[] = [];
    const stack = [start];
    assigned.add(start);
    while (stack.length > 0) {
      budget.check();
      const current = stack.pop();
      if (current === undefined) continue;
      component.push(current);
      const prerequisites = index.prerequisites.get(current) ?? [];
      for (let neighborIndex = prerequisites.length - 1; neighborIndex >= 0; neighborIndex -= 1) {
        const prerequisite = prerequisites[neighborIndex];
        if (prerequisite === undefined || !subset.has(prerequisite) || assigned.has(prerequisite)) continue;
        assigned.add(prerequisite);
        stack.push(prerequisite);
      }
    }
    component.sort(compareIds);
    components.push(component);
  }
  budget.check();
  return components.sort((left, right) => compareIds(left[0] ?? "", right[0] ?? ""));
}

export function shortestPath(
  index: GraphIndex,
  source: string,
  target: string,
  budget: ExecutionBudget,
  allowed: Set<string> = new Set(index.ids),
): string[] | null {
  if (!allowed.has(source) || !allowed.has(target)) return null;
  if (source === target) return [source];
  const queue = [source];
  const previous = new Map<string, string>();
  const visited = new Set([source]);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    if ((cursor & 255) === 0) budget.check();
    const current = queue[cursor];
    if (current === undefined) continue;
    for (const next of index.dependents.get(current) ?? []) {
      if (!allowed.has(next) || visited.has(next)) continue;
      visited.add(next);
      previous.set(next, current);
      if (next === target) {
        const path = [target];
        let cursorNode = target;
        while (cursorNode !== source) {
          const prior = previous.get(cursorNode);
          if (prior === undefined) return null;
          path.push(prior);
          cursorNode = prior;
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

function cycleWitness(index: GraphIndex, component: string[], budget: ExecutionBudget): string[] {
  const allowed = new Set(component);
  const start = component[0];
  if (start === undefined) return [];
  for (const next of index.dependents.get(start) ?? []) {
    if (!allowed.has(next)) continue;
    if (next === start) return [start, start];
    const returnPath = shortestPath(index, next, start, budget, allowed);
    if (returnPath !== null) return [start, ...returnPath];
  }
  return [];
}

export function cycleDiagnostics(
  index: GraphIndex,
  budget: ExecutionBudget,
  subset: Set<string> = new Set(index.ids),
): CycleDiagnostic[] {
  return stronglyConnectedComponents(index, budget, subset)
    .filter((component) => component.length > 1 ||
      (component[0] !== undefined && (index.dependents.get(component[0]) ?? []).includes(component[0])))
    .map((component) => ({ component, witness: cycleWitness(index, component, budget) }));
}

export function assertAcyclic(
  index: GraphIndex,
  budget: ExecutionBudget,
  subset: Set<string> = new Set(index.ids),
): void {
  const cycles = cycleDiagnostics(index, budget, subset);
  if (cycles.length > 0) {
    throw new EngineError("DEPENDENCY_CYCLE", "The relevant dependency graph contains a cycle.", { cycles });
  }
}

export function topologicalLayers(
  index: GraphIndex,
  budget: ExecutionBudget,
  subset: Set<string> = new Set(index.ids),
): string[][] {
  const indegree = new Map<string, number>();
  for (const node of subset) {
    indegree.set(node, (index.prerequisites.get(node) ?? []).filter((id) => subset.has(id)).length);
  }
  let ready = [...subset].filter((node) => indegree.get(node) === 0).sort(compareIds);
  const layers: string[][] = [];
  let processed = 0;
  while (ready.length > 0) {
    budget.check();
    const layer = ready;
    layers.push(layer);
    processed += layer.length;
    const nextReady: string[] = [];
    for (const node of layer) {
      for (const dependent of index.dependents.get(node) ?? []) {
        if (!subset.has(dependent)) continue;
        const value = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, value);
        if (value === 0) nextReady.push(dependent);
      }
    }
    ready = nextReady.sort(compareIds);
  }
  if (processed !== subset.size) {
    throw new EngineError("DEPENDENCY_CYCLE", "The relevant dependency graph contains a cycle.", {
      cycles: cycleDiagnostics(index, budget, subset),
    });
  }
  return layers;
}

export function topologicalOrder(
  index: GraphIndex,
  budget: ExecutionBudget,
  subset: Set<string> = new Set(index.ids),
): string[] {
  return topologicalLayers(index, budget, subset).flat();
}

export function inducedGraph(index: GraphIndex, included: Set<string>): DependencyGraph {
  return {
    schema: index.graph.schema,
    nodes: index.graph.nodes.filter((node) => included.has(node.id)),
    requires: index.graph.requires.filter((relation) =>
      included.has(relation.dependent) && included.has(relation.prerequisite)),
  };
}
