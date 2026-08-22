import type {
  BlockedExplanationResult,
  ExplainRequest,
  ImpactExplanationResult,
  ImpactRequest,
  ImpactResult,
  ResolveRequest,
  ResolveResult,
  SliceRequest,
  SliceResult,
  ValidateRequest,
  ValidateResult,
} from "./contracts.js";
import { byteLength, compareIds, sortedUnique } from "./canonical.js";
import { ExecutionBudget } from "./budget.js";
import { type CompiledGraph } from "./compiled-graph.js";
import {
  assertAcyclic,
  assertKnownNodes,
  closure,
  cycleDiagnostics,
  inducedGraph,
  topologicalLayers,
  topologicalOrder,
  shortestPath,
} from "./graph.js";
import { EngineError } from "./errors.js";

type WithoutReceipt<T extends { receipt: unknown }> = Omit<T, "receipt">;

/** Rejects graphs with declaration issues exactly like a fresh index build did. */
function requireValidIndex(compiled: CompiledGraph) {
  if (compiled.issues.length > 0) {
    throw new EngineError("GRAPH_INVALID", "The dependency graph has invalid declarations.", {
      issues: compiled.issues.slice(0, 32),
      issue_count: compiled.issues.length,
    });
  }
  return compiled.index;
}

export function validateGraph(
  request: ValidateRequest,
  compiled: CompiledGraph,
  budget: ExecutionBudget,
): WithoutReceipt<ValidateResult> {
  if (compiled.issues.length > 0) {
    return {
      status: "ok",
      kind: "validation",
      valid: false,
      node_count: compiled.graph.nodes.length,
      relation_count: compiled.graph.requires.length,
      issues: compiled.issues,
      cycles: [],
      topological_order: null,
      execution_layers: null,
      normalized_graph: compiled.graph,
    };
  }
  const index = compiled.index;
  const cycles = cycleDiagnostics(index, budget);
  const cycleIssues = cycles.map((cycle) => ({
    code: "DEPENDENCY_CYCLE" as const,
    message: `Dependency cycle: ${cycle.witness.join(" -> ")}.`,
    nodes: cycle.component,
  }));
  if (cycles.length > 0) {
    return {
      status: "ok",
      kind: "validation",
      valid: false,
      node_count: index.ids.length,
      relation_count: index.graph.requires.length,
      issues: cycleIssues,
      cycles,
      topological_order: null,
      execution_layers: null,
      normalized_graph: index.graph,
    };
  }
  const executionLayers = topologicalLayers(index, budget);
  return {
    status: "ok",
    kind: "validation",
    valid: true,
    node_count: index.ids.length,
    relation_count: index.graph.requires.length,
    issues: [],
    cycles: [],
    topological_order: executionLayers.flat(),
    execution_layers: executionLayers,
    normalized_graph: index.graph,
  };
}

export function resolveDependencies(
  request: ResolveRequest,
  compiled: CompiledGraph,
  budget: ExecutionBudget,
): WithoutReceipt<ResolveResult> {
  const index = requireValidIndex(compiled);
  const targets = assertKnownNodes(index, request.targets, "targets");
  const satisfied = assertKnownNodes(index, request.satisfied, "satisfied");
  const requiredSet = closure(index, targets, "prerequisites", budget);
  assertAcyclic(index, budget, requiredSet);
  const satisfiedSet = new Set(satisfied);
  const planningSet = closure(index, targets, "prerequisites", budget, satisfiedSet);
  const remainingSet = new Set([...planningSet].filter((node) => !satisfiedSet.has(node)));
  const executionLayers = topologicalLayers(index, budget, remainingSet);
  const ready = executionLayers[0] ?? [];
  const required = topologicalOrder(index, budget, requiredSet);
  const remaining = executionLayers.flat();
  const blocked = remaining
    .map((node) => ({
      node,
      by: (index.prerequisites.get(node) ?? []).filter((id) => remainingSet.has(id)),
    }))
    .filter((item) => item.by.length > 0)
    .sort((left, right) => compareIds(left.node, right.node));
  const pendingTargets = targets.filter((target) => !satisfiedSet.has(target));
  const reachesPendingTarget = new Set<string>();
  const traversed = new Set(pendingTargets);
  const reachQueue = [...pendingTargets];
  for (let cursor = 0; cursor < reachQueue.length; cursor += 1) {
    if ((cursor & 255) === 0) budget.check();
    const current = reachQueue[cursor];
    if (current === undefined) continue;
    for (const upstream of index.prerequisites.get(current) ?? []) {
      if (!remainingSet.has(upstream)) continue;
      reachesPendingTarget.add(upstream);
      if (traversed.has(upstream)) continue;
      traversed.add(upstream);
      reachQueue.push(upstream);
    }
  }
  const rootBlockers = ready.filter((candidate) => reachesPendingTarget.has(candidate));

  return {
    status: "ok",
    kind: "resolution",
    targets,
    satisfied,
    required,
    remaining,
    ready,
    execution_layers: executionLayers,
    blocked,
    root_blockers: sortedUnique(rootBlockers),
  };
}

export function analyzeImpact(
  request: ImpactRequest,
  compiled: CompiledGraph,
  budget: ExecutionBudget,
): WithoutReceipt<ImpactResult> {
  const index = requireValidIndex(compiled);
  const changed = assertKnownNodes(index, request.changed, "changed");
  const changedSet = new Set(changed);
  const direct = sortedUnique(changed.flatMap((node) => index.dependents.get(node) ?? []))
    .filter((node) => !changedSet.has(node));

  const distance = new Map<string, number>();
  const queue = changed.map((node) => ({ node, distance: 0 }));
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    if ((cursor & 255) === 0) budget.check();
    const item = queue[cursor];
    if (item === undefined) continue;
    for (const dependent of index.dependents.get(item.node) ?? []) {
      if (changedSet.has(dependent)) continue;
      const nextDistance = item.distance + 1;
      const previous = distance.get(dependent);
      if (previous === undefined || nextDistance < previous) {
        distance.set(dependent, nextDistance);
        queue.push({ node: dependent, distance: nextDistance });
      }
    }
  }
  const transitive = [...distance.keys()].sort(compareIds);
  const maxDistance = Math.max(0, ...distance.values());
  const layers = Array.from({ length: maxDistance }, (_, indexValue) =>
    transitive.filter((node) => distance.get(node) === indexValue + 1));
  return {
    status: "ok",
    kind: "impact",
    changed,
    direct,
    transitive,
    propagation_layers: layers,
  };
}

export function sliceDependencies(
  request: SliceRequest,
  compiled: CompiledGraph,
  budget: ExecutionBudget,
): WithoutReceipt<SliceResult> {
  const index = requireValidIndex(compiled);
  const focus = assertKnownNodes(index, request.focus, "focus");
  const included = new Set(focus);
  if (request.direction === "prerequisites" || request.direction === "both") {
    for (const node of closure(index, focus, "prerequisites", budget)) included.add(node);
  }
  if (request.direction === "dependents" || request.direction === "both") {
    for (const node of closure(index, focus, "dependents", budget)) included.add(node);
  }
  return {
    status: "ok",
    kind: "slice",
    focus,
    direction: request.direction,
    graph: inducedGraph(index, included),
  };
}

export function explainDependency(
  request: ExplainRequest,
  compiled: CompiledGraph,
  budget: ExecutionBudget,
): WithoutReceipt<BlockedExplanationResult> | WithoutReceipt<ImpactExplanationResult> {
  const index = requireValidIndex(compiled);
  if (request.kind === "impact") {
    const [changed] = assertKnownNodes(index, [request.changed], "changed");
    const [affected] = assertKnownNodes(index, [request.affected], "affected");
    if (changed === undefined || affected === undefined) {
      throw new EngineError("INVALID_REQUEST", "Impact explanation needs changed and affected nodes.");
    }
    const path = shortestPath(index, changed, affected, budget);
    return {
      status: "ok",
      kind: "impact_explanation",
      changed,
      affected,
      reachable: path !== null,
      path,
    };
  }

  const [target] = assertKnownNodes(index, [request.target], "target");
  if (target === undefined) throw new EngineError("INVALID_REQUEST", "Blocked explanation needs a target.");
  const satisfied = assertKnownNodes(index, request.satisfied, "satisfied");
  const satisfiedSet = new Set(satisfied);
  if (satisfiedSet.has(target)) {
    return {
      status: "ok",
      kind: "blocked_explanation",
      target,
      satisfied: true,
      blocked: false,
      direct_blockers: [],
      root_blockers: [],
      paths: [],
    };
  }
  const required = closure(index, [target], "prerequisites", budget);
  assertAcyclic(index, budget, required);
  const planningSet = closure(index, [target], "prerequisites", budget, satisfiedSet);
  const remaining = new Set([...planningSet].filter((node) => !satisfiedSet.has(node)));
  const directBlockers = (index.prerequisites.get(target) ?? []).filter((node) => remaining.has(node));
  if (directBlockers.length === 0) {
    return {
      status: "ok",
      kind: "blocked_explanation",
      target,
      satisfied: false,
      blocked: false,
      direct_blockers: [],
      root_blockers: [],
      paths: [],
    };
  }
  const roots = [...remaining]
    .filter((node) => (index.prerequisites.get(node) ?? []).every((prerequisite) => !remaining.has(prerequisite)))
    .sort(compareIds);

  // One reverse BFS records every remaining node's shortest distance to the
  // target. Paths are reconstructed by choosing the smallest dependent that
  // reduces that distance, preserving the original root-forward code-point
  // tie rule without repeating a traversal for every root. Restricting the
  // tree to remaining work also prevents paths from crossing satisfied nodes.
  const distanceToTarget = new Map<string, number>([[target, 0]]);
  const traversal = [target];
  for (let cursor = 0; cursor < traversal.length; cursor += 1) {
    if ((cursor & 255) === 0) budget.check();
    const current = traversal[cursor];
    if (current === undefined) continue;
    const currentDistance = distanceToTarget.get(current);
    if (currentDistance === undefined) continue;
    for (const upstream of index.prerequisites.get(current) ?? []) {
      if (!remaining.has(upstream) || distanceToTarget.has(upstream)) continue;
      distanceToTarget.set(upstream, currentDistance + 1);
      traversal.push(upstream);
    }
  }
  const nextHop = new Map<string, string>();
  for (const node of traversal) {
    const distance = distanceToTarget.get(node);
    if (distance === undefined || distance === 0) continue;
    const next = (index.dependents.get(node) ?? []).find((candidate) =>
      remaining.has(candidate) && distanceToTarget.get(candidate) === distance - 1);
    if (next !== undefined) nextHop.set(node, next);
  }

  // Reconstruct each root's path and stop as soon as the serialized result
  // cannot fit, instead of materializing every path first and failing late.
  const shell = {
    status: "ok" as const,
    kind: "blocked_explanation" as const,
    target,
    satisfied: false,
    blocked: true,
    direct_blockers: directBlockers,
    root_blockers: roots,
    paths: [] as string[][],
  };
  const shellBytes = byteLength(shell);
  const paths: string[][] = [];
  let pathsBytes = 0;
  for (const root of roots) {
    if (!nextHop.has(root)) continue;
    const path: string[] = [root];
    let node = root;
    while (node !== target) {
      if ((path.length & 255) === 0) budget.check();
      const next = nextHop.get(node);
      if (next === undefined) break;
      path.push(next);
      node = next;
    }
    if (node !== target) continue;
    pathsBytes += byteLength(path) + (paths.length > 0 ? 1 : 0);
    if (shellBytes + pathsBytes > budget.maxResponseBytes) {
      throw new EngineError(
        "RESPONSE_TOO_LARGE",
        `The complete result requires at least ${shellBytes + pathsBytes} bytes, above the ${budget.maxResponseBytes}-byte limit.`,
        { actual_bytes: shellBytes + pathsBytes, max_response_bytes: budget.maxResponseBytes },
      );
    }
    paths.push(path);
  }
  return {
    ...shell,
    paths,
  };
}
