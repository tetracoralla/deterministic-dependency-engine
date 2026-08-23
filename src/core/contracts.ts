import { z } from "zod";

export const ENGINE_NAME = "dependency-engine";
export const ENGINE_VERSION = "0.1.0";
export const GRAPH_SCHEMA_VERSION = "agent-deps/v1";
export const PRODUCT_NAME = "Deterministic Dependency Engine";
export const PRODUCT_SUBTITLE = "Dependency Reasoning Over Declared Graphs";

export const HARD_LIMITS = {
  maxRequestBytes: 262_144,
  maxResponseBytes: 131_072,
  maxNodes: 5_000,
  maxRelations: 20_000,
  maxQueryNodes: 256,
  defaultTimeoutMs: 1_000,
  maxTimeoutMs: 5_000,
  minResponseBytes: 1_024,
} as const;

const boundedIdentifier = z.string()
  .min(1)
  .max(128)
  .refine((value) => value.trim() === value, "Must not start or end with whitespace.")
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Must not contain control characters.");

export const NodeIdSchema = boundedIdentifier.meta({ id: "DependencyNodeId" });

export const DependencyNodeSchema = z.strictObject({
  id: NodeIdSchema,
  label: z.string().min(1).max(256).optional(),
});

export const DependencyRelationSchema = z.strictObject({
  dependent: NodeIdSchema,
  prerequisite: NodeIdSchema,
});

export const DependencyGraphSchema = z.strictObject({
  schema: z.literal(GRAPH_SCHEMA_VERSION),
  nodes: z.array(DependencyNodeSchema).min(1).max(HARD_LIMITS.maxNodes),
  requires: z.array(DependencyRelationSchema).max(HARD_LIMITS.maxRelations),
});

export const ExecutionLimitsSchema = z.strictObject({
  timeout_ms: z.number().int().min(10).max(HARD_LIMITS.maxTimeoutMs).optional(),
  max_response_bytes: z.number().int()
    .min(HARD_LIMITS.minResponseBytes)
    .max(HARD_LIMITS.maxResponseBytes)
    .optional(),
});

const queryNodes = z.array(NodeIdSchema).min(1).max(HARD_LIMITS.maxQueryNodes);
const satisfiedNodes = z.array(NodeIdSchema).max(HARD_LIMITS.maxQueryNodes).default([]);

export const ValidateRequestSchema = z.strictObject({
  graph: DependencyGraphSchema,
  limits: ExecutionLimitsSchema.optional(),
});

export const ResolveRequestSchema = z.strictObject({
  graph: DependencyGraphSchema,
  targets: queryNodes,
  satisfied: satisfiedNodes,
  limits: ExecutionLimitsSchema.optional(),
});

export const ImpactRequestSchema = z.strictObject({
  graph: DependencyGraphSchema,
  changed: queryNodes,
  limits: ExecutionLimitsSchema.optional(),
});

export const SliceDirectionSchema = z.enum(["prerequisites", "dependents", "both"]);

export const SliceRequestSchema = z.strictObject({
  graph: DependencyGraphSchema,
  focus: queryNodes,
  direction: SliceDirectionSchema.default("prerequisites"),
  limits: ExecutionLimitsSchema.optional(),
});

const BlockedExplainRequestSchema = z.strictObject({
  graph: DependencyGraphSchema,
  kind: z.literal("blocked"),
  target: NodeIdSchema,
  satisfied: satisfiedNodes,
  limits: ExecutionLimitsSchema.optional(),
});

const ImpactExplainRequestSchema = z.strictObject({
  graph: DependencyGraphSchema,
  kind: z.literal("impact"),
  changed: NodeIdSchema,
  affected: NodeIdSchema,
  limits: ExecutionLimitsSchema.optional(),
});

export const ExplainRequestSchema = z.discriminatedUnion("kind", [
  BlockedExplainRequestSchema,
  ImpactExplainRequestSchema,
]);

export const OperationSchema = z.enum(["validate", "resolve", "impact", "slice", "explain"]);

export type DependencyNode = z.infer<typeof DependencyNodeSchema>;
export type DependencyRelation = z.infer<typeof DependencyRelationSchema>;
export type DependencyGraph = z.infer<typeof DependencyGraphSchema>;
export type ExecutionLimits = z.infer<typeof ExecutionLimitsSchema>;
export type ValidateRequest = z.infer<typeof ValidateRequestSchema>;
export type ResolveRequest = z.infer<typeof ResolveRequestSchema>;
export type ImpactRequest = z.infer<typeof ImpactRequestSchema>;
export type SliceRequest = z.infer<typeof SliceRequestSchema>;
export type ExplainRequest = z.infer<typeof ExplainRequestSchema>;
export type Operation = z.infer<typeof OperationSchema>;

export interface GraphIssue {
  code: "DUPLICATE_NODE" | "DUPLICATE_RELATION" | "UNKNOWN_NODE" | "DEPENDENCY_CYCLE";
  message: string;
  nodes: string[];
  relation?: DependencyRelation;
}

export interface CycleDiagnostic {
  component: string[];
  witness: string[];
}

export interface CalculationReceipt {
  engine: typeof ENGINE_NAME;
  version: typeof ENGINE_VERSION;
  operation: Operation;
  graph_hash: string;
  request_hash: string;
  result_hash: string;
}

export interface ErrorResult {
  status: "error";
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ValidateResult {
  status: "ok";
  kind: "validation";
  valid: boolean;
  node_count: number;
  relation_count: number;
  issues: GraphIssue[];
  cycles: CycleDiagnostic[];
  topological_order: string[] | null;
  execution_layers: string[][] | null;
  normalized_graph: DependencyGraph;
  receipt: CalculationReceipt;
}

export interface ResolveResult {
  status: "ok";
  kind: "resolution";
  targets: string[];
  satisfied: string[];
  required: string[];
  remaining: string[];
  ready: string[];
  execution_layers: string[][];
  blocked: Array<{ node: string; by: string[] }>;
  root_blockers: string[];
  receipt: CalculationReceipt;
}

export interface ImpactResult {
  status: "ok";
  kind: "impact";
  changed: string[];
  direct: string[];
  transitive: string[];
  propagation_layers: string[][];
  receipt: CalculationReceipt;
}

export interface SliceResult {
  status: "ok";
  kind: "slice";
  focus: string[];
  direction: z.infer<typeof SliceDirectionSchema>;
  graph: DependencyGraph;
  receipt: CalculationReceipt;
}

export interface BlockedExplanationResult {
  status: "ok";
  kind: "blocked_explanation";
  target: string;
  satisfied: boolean;
  blocked: boolean;
  direct_blockers: string[];
  root_blockers: string[];
  paths: string[][];
  receipt: CalculationReceipt;
}

export interface ImpactExplanationResult {
  status: "ok";
  kind: "impact_explanation";
  changed: string;
  affected: string;
  reachable: boolean;
  path: string[] | null;
  receipt: CalculationReceipt;
}

export type SuccessResult = ValidateResult | ResolveResult | ImpactResult | SliceResult |
  BlockedExplanationResult | ImpactExplanationResult;
export type EngineResult = SuccessResult | ErrorResult;

const GraphIssueSchema = z.strictObject({
  code: z.enum(["DUPLICATE_NODE", "DUPLICATE_RELATION", "UNKNOWN_NODE", "DEPENDENCY_CYCLE"]),
  message: z.string(),
  nodes: z.array(NodeIdSchema),
  relation: DependencyRelationSchema.optional(),
});

const CycleDiagnosticSchema = z.strictObject({
  component: z.array(NodeIdSchema),
  witness: z.array(NodeIdSchema),
});

export const CalculationReceiptSchema = z.strictObject({
  engine: z.literal(ENGINE_NAME),
  version: z.literal(ENGINE_VERSION),
  operation: OperationSchema,
  graph_hash: z.string().regex(/^[0-9a-f]{64}$/u),
  request_hash: z.string().regex(/^[0-9a-f]{64}$/u),
  result_hash: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const ErrorResultSchema = z.strictObject({
  status: z.literal("error"),
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export const ValidateResultSchema = z.strictObject({
  status: z.literal("ok"),
  kind: z.literal("validation"),
  valid: z.boolean(),
  node_count: z.number().int().nonnegative(),
  relation_count: z.number().int().nonnegative(),
  issues: z.array(GraphIssueSchema),
  cycles: z.array(CycleDiagnosticSchema),
  topological_order: z.array(NodeIdSchema).nullable(),
  execution_layers: z.array(z.array(NodeIdSchema)).nullable(),
  normalized_graph: DependencyGraphSchema,
  receipt: CalculationReceiptSchema,
});

export const ResolveResultSchema = z.strictObject({
  status: z.literal("ok"),
  kind: z.literal("resolution"),
  targets: z.array(NodeIdSchema),
  satisfied: z.array(NodeIdSchema),
  required: z.array(NodeIdSchema),
  remaining: z.array(NodeIdSchema),
  ready: z.array(NodeIdSchema),
  execution_layers: z.array(z.array(NodeIdSchema)),
  blocked: z.array(z.strictObject({ node: NodeIdSchema, by: z.array(NodeIdSchema) })),
  root_blockers: z.array(NodeIdSchema),
  receipt: CalculationReceiptSchema,
});

export const ImpactResultSchema = z.strictObject({
  status: z.literal("ok"),
  kind: z.literal("impact"),
  changed: z.array(NodeIdSchema),
  direct: z.array(NodeIdSchema),
  transitive: z.array(NodeIdSchema),
  propagation_layers: z.array(z.array(NodeIdSchema)),
  receipt: CalculationReceiptSchema,
});

export const SliceResultSchema = z.strictObject({
  status: z.literal("ok"),
  kind: z.literal("slice"),
  focus: z.array(NodeIdSchema),
  direction: SliceDirectionSchema,
  graph: DependencyGraphSchema,
  receipt: CalculationReceiptSchema,
});

export const BlockedExplanationResultSchema = z.strictObject({
  status: z.literal("ok"),
  kind: z.literal("blocked_explanation"),
  target: NodeIdSchema,
  satisfied: z.boolean(),
  blocked: z.boolean(),
  direct_blockers: z.array(NodeIdSchema),
  root_blockers: z.array(NodeIdSchema),
  paths: z.array(z.array(NodeIdSchema)),
  receipt: CalculationReceiptSchema,
});

export const ImpactExplanationResultSchema = z.strictObject({
  status: z.literal("ok"),
  kind: z.literal("impact_explanation"),
  changed: NodeIdSchema,
  affected: NodeIdSchema,
  reachable: z.boolean(),
  path: z.array(NodeIdSchema).nullable(),
  receipt: CalculationReceiptSchema,
});

export const ExplainResultSchema = z.union([
  BlockedExplanationResultSchema,
  ImpactExplanationResultSchema,
]);

export const EngineResultSchema = z.union([
  ValidateResultSchema,
  ResolveResultSchema,
  ImpactResultSchema,
  SliceResultSchema,
  ExplainResultSchema,
  ErrorResultSchema,
]);
