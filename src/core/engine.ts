import type {
  BlockedExplanationResult,
  CalculationReceipt,
  DependencyGraph,
  EngineResult,
  ErrorResult,
  ExplainRequest,
  GraphIssue,
  ImpactExplanationResult,
  ImpactRequest,
  ImpactResult,
  Operation,
  ResolveRequest,
  ResolveResult,
  SliceRequest,
  SliceResult,
  SuccessResult,
  ValidateRequest,
  ValidateResult,
} from "./contracts.js";
import {
  BlockedExplanationResultSchema,
  ENGINE_NAME,
  ENGINE_VERSION,
  ExplainRequestSchema,
  ImpactExplanationResultSchema,
  ImpactRequestSchema,
  ImpactResultSchema,
  ResolveRequestSchema,
  ResolveResultSchema,
  SliceRequestSchema,
  SliceResultSchema,
  ValidateRequestSchema,
  ValidateResultSchema,
} from "./contracts.js";
import { assertRequestSize, ExecutionBudget, executionLimitsFromInput } from "./budget.js";
import { hashJsonParts, hashValue, sortedUnique, stableJson } from "./canonical.js";
import { getCompiledGraph, type CompiledGraph } from "./compiled-graph.js";
import { boundedErrorResult } from "./errors.js";
import {
  analyzeImpact,
  explainDependency,
  resolveDependencies,
  sliceDependencies,
  validateGraph,
} from "./operations.js";

// Each operation validates its result against the exact schema for the kind it
// produced, instead of re-scanning the generic success/error union.
const RESULT_SCHEMA_BY_KIND = {
  validation: ValidateResultSchema,
  resolution: ResolveResultSchema,
  impact: ImpactResultSchema,
  slice: SliceResultSchema,
  blocked_explanation: BlockedExplanationResultSchema,
  impact_explanation: ImpactExplanationResultSchema,
} as const;

type ResultKind = keyof typeof RESULT_SCHEMA_BY_KIND;

function canonicalQuery(request: Record<string, unknown>): unknown {
  return Object.fromEntries(Object.entries(request)
    .filter(([key]) => key !== "graph" && key !== "limits")
    .map(([key, value]) => [key, Array.isArray(value) && value.every((item) => typeof item === "string")
      ? sortedUnique(value as string[])
      : value]));
}

function attachReceipt<T extends Omit<SuccessResult, "receipt">>(
  operation: Operation,
  request: Record<string, unknown>,
  result: T,
  budget: ExecutionBudget,
  compiled: CompiledGraph,
): T & { receipt: CalculationReceipt } {
  budget.check();
  // Hash the canonical request by splicing the cached canonical graph bytes
  // between the framing fragments, instead of concatenating and re-encoding
  // the whole serialized graph a second time per call.
  const receipt: CalculationReceipt = {
    engine: ENGINE_NAME,
    version: ENGINE_VERSION,
    operation,
    graph_hash: compiled.graphHash,
    request_hash: hashJsonParts(
      `{"graph":`,
      compiled.canonicalBytes,
      `,"operation":${JSON.stringify(operation)},"query":${stableJson(canonicalQuery(request))}}`,
    ),
    result_hash: hashValue(result),
  };
  budget.check();
  const completed = { ...result, receipt };
  const parsed = RESULT_SCHEMA_BY_KIND[result.kind as ResultKind].parse(completed) as unknown as
    T & { receipt: CalculationReceipt };
  budget.check();
  budget.assertResponse(parsed);
  return parsed;
}

// requestBytes, when provided, must equal byteLength(input) so adapters that
// already serialized the request for routing skip the second serialization.
function runOperationInternal(
  operation: Operation,
  input: unknown,
  startedAt: number,
  requestBytes?: number,
): EngineResult {
  let budget = new ExecutionBudget(undefined, startedAt);
  try {
    budget = new ExecutionBudget(executionLimitsFromInput(input), startedAt);
    assertRequestSize(input, requestBytes);
    budget.check();
    if (operation === "validate") {
      const request = ValidateRequestSchema.parse(input);
      const compiled = getCompiledGraph((request as { graph: DependencyGraph }).graph);
      budget.check();
      return attachReceipt(operation, request, validateGraph(request, compiled, budget), budget, compiled) as ValidateResult as SuccessResult;
    }
    if (operation === "resolve") {
      const request = ResolveRequestSchema.parse(input);
      const compiled = getCompiledGraph((request as { graph: DependencyGraph }).graph);
      budget.check();
      return attachReceipt(operation, request, resolveDependencies(request, compiled, budget), budget, compiled) as ResolveResult as SuccessResult;
    }
    if (operation === "impact") {
      const request = ImpactRequestSchema.parse(input);
      const compiled = getCompiledGraph((request as { graph: DependencyGraph }).graph);
      budget.check();
      return attachReceipt(operation, request, analyzeImpact(request, compiled, budget), budget, compiled) as ImpactResult as SuccessResult;
    }
    if (operation === "slice") {
      const request = SliceRequestSchema.parse(input);
      const compiled = getCompiledGraph((request as { graph: DependencyGraph }).graph);
      budget.check();
      return attachReceipt(operation, request, sliceDependencies(request, compiled, budget), budget, compiled) as SliceResult as SuccessResult;
    }
    const request = ExplainRequestSchema.parse(input);
    const compiled = getCompiledGraph((request as { graph: DependencyGraph }).graph);
    budget.check();
    return attachReceipt(operation, request, explainDependency(request, compiled, budget), budget, compiled) as
      (BlockedExplanationResult | ImpactExplanationResult) as SuccessResult;
  } catch (error) {
    return boundedErrorResult(error, budget.maxResponseBytes);
  }
}

/** Public library entry: callers cannot substitute their own request-size fact. */
export function runOperation(
  operation: Operation,
  input: unknown,
  startedAt = performance.now(),
): EngineResult {
  return runOperationInternal(operation, input, startedAt);
}

export type GraphProjectionResult = ErrorResult | {
  status: "ok";
  graph: DependencyGraph;
  executionLayers: string[][] | null;
  issues: GraphIssue[];
};

/**
 * Internal browser-view preparation. It uses the same validation operation and
 * request/deadline checks, but returns in-memory references instead of
 * serializing a second copy of the graph into a public calculation result.
 */
export function prepareGraphProjection(
  input: unknown,
  startedAt = performance.now(),
): GraphProjectionResult {
  let budget = new ExecutionBudget(undefined, startedAt);
  try {
    budget = new ExecutionBudget(executionLimitsFromInput(input), startedAt);
    assertRequestSize(input);
    budget.check();
    const request = ValidateRequestSchema.parse(input);
    const compiled = getCompiledGraph((request as { graph: DependencyGraph }).graph);
    budget.check();
    const validation = validateGraph(request, compiled, budget);
    budget.check();
    return {
      status: "ok",
      graph: validation.normalized_graph,
      executionLayers: validation.execution_layers,
      issues: validation.issues,
    };
  } catch (error) {
    return boundedErrorResult(error, budget.maxResponseBytes);
  }
}

/**
 * Adapter-only entry for a request size measured from this exact parsed value.
 * This is deliberately omitted from the package root exports.
 */
export function runMeasuredOperation(
  operation: Operation,
  input: unknown,
  startedAt: number,
  requestBytes: number,
): EngineResult {
  return runOperationInternal(operation, input, startedAt, requestBytes);
}

export const validate = (input: ValidateRequest): EngineResult => runOperation("validate", input);
export const resolve = (input: ResolveRequest): EngineResult => runOperation("resolve", input);
export const impact = (input: ImpactRequest): EngineResult => runOperation("impact", input);
export const slice = (input: SliceRequest): EngineResult => runOperation("slice", input);
export const explain = (input: ExplainRequest): EngineResult => runOperation("explain", input);
