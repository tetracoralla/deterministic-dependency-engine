import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { byteLength } from "../src/core/canonical.js";
import { HARD_LIMITS } from "../src/core/contracts.js";
import { createDependencyMcpServer, PUBLIC_TOOL_NAMES } from "../src/adapters/mcp.js";
import { exampleGraph } from "./fixtures.js";

function starGraph(count: number) {
  const nodes = Array.from({ length: count }, (_, index) => ({ id: `node-${String(index).padStart(4, "0")}` }));
  nodes.push({ id: "target" });
  return {
    schema: "agent-deps/v1" as const,
    nodes,
    requires: nodes.slice(0, count).map((node) => ({ dependent: "target", prerequisite: node.id })),
  };
}

async function withClient(run: (client: Client) => Promise<void>): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createDependencyMcpServer();
  const client = new Client({ name: "dependency-engine-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("MCP adapter", () => {
  it("advertises five strict, read-only, direct tools", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createDependencyMcpServer();
    const client = new Client({ name: "dependency-engine-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([...PUBLIC_TOOL_NAMES]);
      expect(Buffer.byteLength(JSON.stringify(listed))).toBeLessThan(80_000);
      for (const tool of listed.tools) {
        expect(tool.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
        if (tool.name !== "dependency_explain") {
          expect(tool.inputSchema.additionalProperties).toBe(false);
        }
        expect(tool.outputSchema).toBeDefined();
      }
      const explainTool = listed.tools.find((tool) => tool.name === "dependency_explain");
      const explainBranches = explainTool?.inputSchema.oneOf;
      expect(explainTool?.inputSchema.type).toBe("object");
      expect(Array.isArray(explainBranches)).toBe(true);
      expect(explainBranches).toHaveLength(2);
      for (const branch of Array.isArray(explainBranches) ? explainBranches : []) {
        expect(branch).toMatchObject({ type: "object", additionalProperties: false });
      }
      const resolveTool = listed.tools.find((tool) => tool.name === "dependency_resolve");
      expect(JSON.stringify(resolveTool?.inputSchema)).toContain("dependent");
      expect(JSON.stringify(resolveTool?.inputSchema)).toContain("prerequisite");
      expect(JSON.stringify(resolveTool?.inputSchema)).not.toContain("\"from\"");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("executes the dominant route and rejects misspelled fields", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createDependencyMcpServer();
    const client = new Client({ name: "dependency-engine-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const resolved = await client.callTool({
        name: "dependency_resolve",
        arguments: { graph: exampleGraph, targets: ["release"], satisfied: ["schema", "backend"] },
      });
      expect(resolved.isError).toBeUndefined();
      const envelope = resolved.structuredContent as { result?: { status?: string; ready?: string[] } } | undefined;
      expect(envelope?.result?.status).toBe("ok");
      expect(envelope?.result?.ready).toEqual(["ui"]);

      const invalid = await client.callTool({
        name: "dependency_resolve",
        arguments: { graph: exampleGraph, targetz: ["release"], satisfied: [] },
      });
      expect(invalid.isError).toBe(true);
      const invalidEnvelope = invalid.structuredContent as {
        result?: { status?: string; error?: { code?: string } };
      } | undefined;
      expect(invalidEnvelope?.result?.status).toBe("error");
      expect(invalidEnvelope?.result?.error?.code).toBe("INVALID_REQUEST");

      const wrongExplainBranch = await client.callTool({
        name: "dependency_explain",
        arguments: { graph: exampleGraph, kind: "blocked", changed: "schema", affected: "release" },
      });
      expect(wrongExplainBranch.isError).toBe(true);
      const wrongBranchEnvelope = wrongExplainBranch.structuredContent as {
        result?: { error?: { code?: string } };
      } | undefined;
      expect(wrongBranchEnvelope?.result?.error?.code).toBe("INVALID_REQUEST");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("delivers a large legal result whose core size fits the default limit", async () => {
    await withClient(async (client) => {
      const resolved = await client.callTool({
        name: "dependency_resolve",
        arguments: { graph: starGraph(1_600), targets: ["target"], satisfied: [] },
      });
      expect(resolved.isError).toBeUndefined();
      const envelope = resolved.structuredContent as { result?: { status?: string; ready?: string[] } } | undefined;
      expect(envelope?.result?.status).toBe("ok");
      expect(envelope?.result?.ready).toHaveLength(1_600);
      expect(Buffer.byteLength(JSON.stringify(envelope?.result))).toBeLessThanOrEqual(HARD_LIMITS.maxResponseBytes);
      expect(Buffer.byteLength(JSON.stringify(resolved))).toBeLessThanOrEqual(HARD_LIMITS.maxResponseBytes);
      const text = ((resolved.content ?? []) as Array<{ type: string; text?: string }>)
        .find((item) => item.type === "text");
      expect(text?.text ?? "").toContain("…and");
    });
  });

  it("drops the text rendering before failing when only the complete envelope overflows", async () => {
    await withClient(async (client) => {
      const request = { graph: starGraph(1_600), targets: ["target"], satisfied: [] };
      const withText = await client.callTool({ name: "dependency_resolve", arguments: request });
      expect(withText.isError).toBeUndefined();
      const withTextBytes = Buffer.byteLength(JSON.stringify(withText));
      const resultOnly = JSON.stringify((withText.structuredContent as { result?: unknown }).result);
      const resultBytes = Buffer.byteLength(resultOnly);
      // A limit between the structured payload and the full envelope forces the
      // degrade-to-structured-only path instead of losing the whole result.
      const limited = { ...request, limits: { max_response_bytes: Math.min(resultBytes + 64, withTextBytes - 1) } };
      const degraded = await client.callTool({ name: "dependency_resolve", arguments: limited });
      expect(degraded.isError).toBeUndefined();
      const degradedEnvelope = degraded.structuredContent as { result?: { status?: string } } | undefined;
      expect(degradedEnvelope?.result?.status).toBe("ok");
      expect(degraded.content ?? []).toHaveLength(0);
      expect(Buffer.byteLength(JSON.stringify(degraded))).toBeLessThanOrEqual(
        (limited.limits as { max_response_bytes: number }).max_response_bytes,
      );
      expect(resultBytes).toBeGreaterThan(64_000);
    });
  });
});
