#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  ENGINE_VERSION,
  ErrorResultSchema,
  ExplainRequestSchema,
  ExplainResultSchema,
  HARD_LIMITS,
  ImpactRequestSchema,
  ImpactResultSchema,
  PRODUCT_NAME,
  ResolveRequestSchema,
  ResolveResultSchema,
  SliceRequestSchema,
  SliceResultSchema,
  ValidateRequestSchema,
  ValidateResultSchema,
  type EngineResult,
  type ErrorResult,
  type Operation,
} from "../core/contracts.js";
import { deadlineExceeded, responseLimitFromInput } from "../core/budget.js";
import { byteLength } from "../core/canonical.js";
import { executeOperation } from "./compute-pool.js";
import { responseTooLargeResult, timeoutResult } from "../core/errors.js";
import { presentResult } from "../core/presentation.js";
import { isMainModule } from "./main-module.js";

// The core request ceiling is maxRequestBytes; the transport buffer also holds
// JSON-RPC framing around the arguments. Keeping the buffer close to that
// ceiling rejects runaway input at the transport, before buffering, JSON
// parsing, or object construction can multiply it in memory.
const TRANSPORT_MAX_BUFFER_BYTES = HARD_LIMITS.maxRequestBytes + 65_536;

export const PUBLIC_TOOL_NAMES = [
  "graph_validate",
  "dependency_resolve",
  "dependency_impact",
  "dependency_slice",
  "dependency_explain",
] as const;

type PublicToolName = typeof PUBLIC_TOOL_NAMES[number];

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function outputSchema(success: z.ZodType) {
  return z.strictObject({ result: z.union([success, ErrorResultSchema]) });
}

interface ToolSpec {
  name: PublicToolName;
  title: string;
  description: string;
  operation: Operation;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
}

const TOOL_SPECS: ToolSpec[] = [
  {
    name: "graph_validate",
    title: "Validate dependency graph",
    description: "Validate declared dependencies, find repairable cycles, and compute stable topological order and parallel layers when acyclic.",
    operation: "validate",
    inputSchema: ValidateRequestSchema,
    outputSchema: outputSchema(ValidateResultSchema),
  },
  {
    name: "dependency_resolve",
    title: "Resolve dependency plan",
    description: "Compute what targets require, what remains, what is ready now, stable execution layers, direct blockers, and root blockers. Default one-call route for 'what must happen before X?'.",
    operation: "resolve",
    inputSchema: ResolveRequestSchema,
    outputSchema: outputSchema(ResolveResultSchema),
  },
  {
    name: "dependency_impact",
    title: "Analyze dependency impact",
    description: "Compute direct and transitive downstream effects plus propagation distance layers for changed declared nodes.",
    operation: "impact",
    inputSchema: ImpactRequestSchema,
    outputSchema: outputSchema(ImpactResultSchema),
  },
  {
    name: "dependency_slice",
    title: "Slice dependency graph",
    description: "Return only the canonical prerequisite, dependent, or bidirectional subgraph relevant to focus nodes.",
    operation: "slice",
    inputSchema: SliceRequestSchema,
    outputSchema: outputSchema(SliceResultSchema),
  },
  {
    name: "dependency_explain",
    title: "Explain blocker or impact path",
    description: "Return structured root-blocker paths for one target or one shortest stable path showing why a changed node affects another node.",
    operation: "explain",
    inputSchema: ExplainRequestSchema,
    outputSchema: outputSchema(ExplainResultSchema),
  },
];

function objectJsonSchema(schema: z.ZodType): Tool["inputSchema"] {
  const generated = z.toJSONSchema(schema, { target: "draft-7", reused: "ref" });
  return { ...generated, type: "object" } as Tool["inputSchema"];
}

const TOOL_DEFINITIONS: Tool[] = TOOL_SPECS.map((spec) => ({
  name: spec.name,
  title: spec.title,
  description: spec.description,
  inputSchema: objectJsonSchema(spec.inputSchema),
  outputSchema: objectJsonSchema(spec.outputSchema),
  annotations: READ_ONLY_ANNOTATIONS,
}));

const TOOL_BY_NAME = new Map(TOOL_SPECS.map((spec) => [spec.name, spec]));

function envelopeForResult(result: EngineResult, withText: boolean): CallToolResult {
  return {
    content: withText ? [{ type: "text", text: presentResult(result) }] : [],
    structuredContent: { result },
    ...(result.status === "error" ? { isError: true } : {}),
  };
}

function toolResult(result: EngineResult, input: unknown, startedAt: number): CallToolResult {
  const maxResponseBytes = responseLimitFromInput(input);
  let envelope = envelopeForResult(result, true);
  if (deadlineExceeded(input, startedAt)) {
    result = timeoutResult(maxResponseBytes);
    envelope = envelopeForResult(result, true);
  }
  if (byteLength(envelope) <= maxResponseBytes) return envelope;
  // The structured result fits the core limit but the complete envelope does not:
  // deliver the structured result without the redundant text rendering first.
  const structuredOnly = envelopeForResult(result, false);
  if (byteLength(structuredOnly) <= maxResponseBytes) return structuredOnly;
  result = responseTooLargeResult(
    byteLength(envelope),
    maxResponseBytes,
    result.status === "error" ? result.error.code : undefined,
  );
  return envelopeForResult(result, true);
}

function unknownToolResult(name: string): CallToolResult {
  const result: ErrorResult = {
    status: "error",
    error: {
      code: "UNKNOWN_TOOL",
      message: `Unknown dependency tool: ${name}.`,
    },
  };
  return envelopeForResult(result, true);
}

export function createDependencyMcpServer(): Server {
  const server = new Server(
    { name: "dependency-engine", version: ENGINE_VERSION },
    {
      capabilities: { tools: {} },
      instructions: `${PRODUCT_NAME} is a deterministic dependency engine. Use one direct dependency tool for declared graph relations. Edges are dependent/prerequisite, never from/to. Results prove derivations over declarations, not the truth of declarations.`,
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const startedAt = performance.now();
    const spec = TOOL_BY_NAME.get(request.params.name as PublicToolName);
    if (spec === undefined) return unknownToolResult(request.params.name);
    const input = request.params.arguments ?? {};
    // Slow or pathological requests run in isolated compute children so they
    // cannot block every other call on this server's event loop. The request
    // is serialized exactly once here: the size both routes the call and is
    // forwarded as the core's authoritative request-size measurement.
    const requestBytes = byteLength(input);
    const result = await executeOperation(spec.operation, input, startedAt, requestBytes);
    return toolResult(result, input, startedAt);
  });
  return server;
}

export async function main(): Promise<void> {
  const server = createDependencyMcpServer();
  const transport = new StdioServerTransport(
    process.stdin,
    process.stdout,
    { maxBufferSize: TRANSPORT_MAX_BUFFER_BYTES },
  );
  transport.onerror = (error: Error) => {
    process.stderr.write(`${PRODUCT_NAME} MCP transport closed: ${error.message}\n`);
  };
  // An over-limit inbound message closes the transport by design. Exiting lets
  // the host restart the server into a clean state instead of leaving a
  // half-open connection; in-limit requests never reach this path.
  server.onclose = () => {
    process.exit(0);
  };
  await server.connect(transport);
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown MCP failure";
    process.stderr.write(`${PRODUCT_NAME} MCP error: ${message}\n`);
    process.exitCode = 1;
  });
}
