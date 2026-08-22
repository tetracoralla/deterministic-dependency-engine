import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { handleHttpRequest } from "../dist/adapters/http-worker.js";
import { runOperation } from "../dist/core/engine.js";

const graph = {
  schema: "agent-deps/v1",
  nodes: [{ id: "schema" }, { id: "backend" }, { id: "release" }],
  requires: [
    { dependent: "backend", prerequisite: "schema" },
    { dependent: "release", prerequisite: "backend" },
  ],
};
const request = { graph, targets: ["release"], satisfied: ["schema"] };

const cli = spawnSync(process.execPath, ["dist/adapters/cli.js", "resolve"], {
  cwd: process.cwd(),
  input: JSON.stringify(request),
  encoding: "utf8",
  timeout: 10_000,
});
assert.equal(cli.status, 0, cli.stderr || cli.stdout);
const cliResult = JSON.parse(cli.stdout);
assert.deepEqual(cliResult.ready, ["backend"]);

const cliUnknown = spawnSync(process.execPath, ["dist/adapters/cli.js", "frobnicate"], {
  cwd: process.cwd(),
  encoding: "utf8",
  timeout: 10_000,
});
assert.equal(cliUnknown.status, 1, cliUnknown.stderr || cliUnknown.stdout);
assert.equal(JSON.parse(cliUnknown.stdout).error.code, "CLI_USAGE");

const cliOversized = spawnSync(process.execPath, ["dist/adapters/cli.js", "resolve"], {
  cwd: process.cwd(),
  input: "x".repeat(262_145),
  encoding: "utf8",
  timeout: 10_000,
});
assert.equal(cliOversized.status, 1, cliOversized.stderr || cliOversized.stdout);
assert.equal(JSON.parse(cliOversized.stdout).error.code, "REQUEST_TOO_LARGE");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/adapters/mcp.js"],
  cwd: process.cwd(),
  stderr: "pipe",
});
const client = new Client({ name: "dependency-engine-runtime-probe", version: "1.0.0" });
await client.connect(transport);
try {
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    "graph_validate",
    "dependency_resolve",
    "dependency_impact",
    "dependency_slice",
    "dependency_explain",
  ]);
  const explainTool = tools.tools.find((tool) => tool.name === "dependency_explain");
  assert.equal(explainTool.inputSchema.type, "object");
  assert.equal(explainTool.inputSchema.oneOf.length, 2);
  const resolved = await client.callTool({ name: "dependency_resolve", arguments: request });
  const result = resolved.structuredContent?.result;
  assert.equal(result.status, "ok");
  assert.deepEqual(result.ready, ["backend"]);
  const remainingValidCalls = [
    { name: "graph_validate", arguments: { graph }, kind: "validation" },
    { name: "dependency_impact", arguments: { graph, changed: ["schema"] }, kind: "impact" },
    { name: "dependency_slice", arguments: { graph, focus: ["release"], direction: "prerequisites" }, kind: "slice" },
    { name: "dependency_explain", arguments: { graph, kind: "blocked", target: "release", satisfied: ["schema"] }, kind: "blocked_explanation" },
  ];
  for (const call of remainingValidCalls) {
    const called = await client.callTool({ name: call.name, arguments: call.arguments });
    assert.notEqual(called.isError, true, `${call.name} unexpectedly failed`);
    assert.equal(called.structuredContent?.result?.status, "ok");
    assert.equal(called.structuredContent?.result?.kind, call.kind);
  }
  const misspelled = await client.callTool({
    name: "dependency_resolve",
    arguments: { graph, targetz: ["release"], satisfied: [] },
  });
  assert.equal(misspelled.isError, true);
  assert.equal(misspelled.structuredContent?.result?.error?.code, "INVALID_REQUEST");
  const cyclicGraph = {
    schema: "agent-deps/v1",
    nodes: [{ id: "a" }, { id: "b" }],
    requires: [
      { dependent: "a", prerequisite: "b" },
      { dependent: "b", prerequisite: "a" },
    ],
  };
  const cyclic = await client.callTool({
    name: "dependency_resolve",
    arguments: { graph: cyclicGraph, targets: ["a"], satisfied: [] },
  });
  assert.equal(cyclic.isError, true);
  assert.equal(cyclic.structuredContent?.result?.error?.code, "DEPENDENCY_CYCLE");
  const oversizedMcp = await client.callTool({
    name: "dependency_resolve",
    arguments: { ...request, padding: "x".repeat(262_144) },
  });
  assert.equal(oversizedMcp.isError, true);
  assert.equal(oversizedMcp.structuredContent?.result?.error?.code, "REQUEST_TOO_LARGE");

  const chainNodes = Array.from({ length: 24 }, (_, index) => ({ id: `n${index}` }));
  const sliceRequest = {
    graph: {
      schema: "agent-deps/v1",
      nodes: chainNodes,
      requires: chainNodes.slice(1).map((node, index) => ({
        dependent: node.id,
        prerequisite: chainNodes[index].id,
      })),
    },
    focus: [chainNodes.at(-1).id],
    direction: "prerequisites",
  };
  const baselineSlice = runOperation("slice", sliceRequest);
  assert.equal(baselineSlice.status, "ok");
  const responseLimit = Buffer.byteLength(JSON.stringify(baselineSlice));
  assert.ok(responseLimit >= 1_024 && responseLimit <= 131_072);
  const limitedSliceRequest = {
    ...sliceRequest,
    limits: { max_response_bytes: responseLimit },
  };
  const mcpLimited = await client.callTool({
    name: "dependency_slice",
    arguments: limitedSliceRequest,
  });
  assert.equal(mcpLimited.isError, true);
  assert.equal(mcpLimited.structuredContent?.result?.error?.code, "RESPONSE_TOO_LARGE");
  assert.ok(Buffer.byteLength(JSON.stringify(mcpLimited)) <= responseLimit);
  const recoveredMcp = await client.callTool({ name: "dependency_resolve", arguments: request });
  assert.notEqual(recoveredMcp.isError, true);
  assert.equal(recoveredMcp.structuredContent?.result?.status, "ok");

  // Requests above the inline threshold must complete through the isolated
  // compute pool (forked engine children) and stay correct end to end.
  const poolNodes = Array.from({ length: 1_600 }, (_, index) => ({ id: `node-${String(index).padStart(4, "0")}` }));
  poolNodes.push({ id: "target" });
  const poolGraph = {
    schema: "agent-deps/v1",
    nodes: poolNodes,
    requires: poolNodes.slice(0, 1_600).map((node) => ({ dependent: "target", prerequisite: node.id })),
  };
  const pooledRequest = { graph: poolGraph, targets: ["target"], satisfied: [] };
  assert.ok(Buffer.byteLength(JSON.stringify(pooledRequest)) > 32_768);
  const pooledMcp = await client.callTool({ name: "dependency_resolve", arguments: pooledRequest });
  assert.notEqual(pooledMcp.isError, true, "pooled MCP call failed");
  assert.equal(pooledMcp.structuredContent?.result?.status, "ok");
  assert.equal(pooledMcp.structuredContent?.result?.ready?.length, 1_600);
  const pooledHttp = await handleHttpRequest(new Request("http://local/v1/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pooledRequest),
  }));
  const pooledHttpText = await pooledHttp.text();
  assert.equal(pooledHttp.status, 200, pooledHttpText);
  assert.equal(JSON.parse(pooledHttpText).status, "ok");
  // Inline calls still answer while the pool exists.
  const inlineAfterPool = await client.callTool({ name: "dependency_resolve", arguments: request });
  assert.notEqual(inlineAfterPool.isError, true);
  assert.equal(inlineAfterPool.structuredContent?.result?.status, "ok");

  // A pooled call that fails structurally (a declared cycle) must not
  // contaminate later calls through either adapter surface.
  const ringNodes = Array.from({ length: 1_600 }, (_, index) => ({ id: `ring-${String(index).padStart(4, "0")}` }));
  const cycleGraph = {
    schema: "agent-deps/v1",
    nodes: ringNodes,
    requires: ringNodes.map((node, index) => ({
      dependent: node.id,
      prerequisite: ringNodes[(index + 1) % ringNodes.length].id,
    })),
  };
  const pooledCycleRequest = { graph: cycleGraph, targets: [ringNodes[0].id], satisfied: [] };
  assert.ok(Buffer.byteLength(JSON.stringify(pooledCycleRequest)) > 32_768);
  const pooledCycle = await client.callTool({ name: "dependency_resolve", arguments: pooledCycleRequest });
  assert.equal(pooledCycle.isError, true);
  assert.equal(pooledCycle.structuredContent?.result?.error?.code, "DEPENDENCY_CYCLE");
  const inlineAfterFailure = await client.callTool({ name: "dependency_resolve", arguments: request });
  assert.notEqual(inlineAfterFailure.isError, true);
  assert.equal(inlineAfterFailure.structuredContent?.result?.status, "ok");

  const cliLimited = spawnSync(process.execPath, ["dist/adapters/cli.js", "slice", "--pretty"], {
    cwd: process.cwd(),
    input: JSON.stringify(limitedSliceRequest),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(cliLimited.status, 1, cliLimited.stderr || cliLimited.stdout);
  assert.equal(JSON.parse(cliLimited.stdout).error.code, "RESPONSE_TOO_LARGE");
  assert.ok(Buffer.byteLength(cliLimited.stdout) <= responseLimit);

  const limitedHttp = await handleHttpRequest(new Request("http://local/v1/slice", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(limitedSliceRequest),
  }));
  const limitedHttpText = await limitedHttp.text();
  assert.equal(limitedHttp.status, 200, limitedHttpText);
  assert.ok(Buffer.byteLength(limitedHttpText) <= responseLimit);
} finally {
  await client.close();
}

const http = await handleHttpRequest(new Request("http://local/v1/resolve", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(request),
}));
assert.equal(http.status, 200);
assert.deepEqual((await http.json()).ready, ["backend"]);

const wrongMethod = await handleHttpRequest(new Request("http://local/v1/resolve"));
assert.equal(wrongMethod.status, 405);
assert.equal(wrongMethod.headers.get("allow"), "POST");

const lookalikeMediaType = await handleHttpRequest(new Request("http://local/v1/resolve", {
  method: "POST",
  headers: { "content-type": "application/jsonp" },
  body: "{}",
}));
assert.equal(lookalikeMediaType.status, 415);

const oversizedHttp = await handleHttpRequest(new Request("http://local/v1/resolve", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "x".repeat(262_145),
}));
assert.equal(oversizedHttp.status, 413);
assert.equal((await oversizedHttp.json()).error.code, "REQUEST_TOO_LARGE");

const recoveredHttp = await handleHttpRequest(new Request("http://local/v1/resolve", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(request),
}));
assert.equal(recoveredHttp.status, 200);

// Stalled and trickling partial bodies must not hold real server connections
// open beyond the socket-level limits that back the engine deadline.
const httpServer = spawn(process.execPath, ["dist/adapters/http-server.js", "--host", "127.0.0.1", "--port", "0"], {
  cwd: process.cwd(),
  stdio: ["ignore", "ignore", "pipe"],
});
try {
  const port = await new Promise((resolvePort, rejectPort) => {
    let stderr = "";
    const cleanup = () => {
      clearTimeout(timer);
      httpServer.stderr.off("data", onData);
      httpServer.off("error", onError);
      httpServer.off("exit", onExit);
    };
    const rejectWithCleanup = (error) => {
      cleanup();
      rejectPort(error);
    };
    const onData = (chunk) => {
      stderr += String(chunk);
      const match = /:(\d+)\s*$/.exec(String(chunk).trim());
      if (match) {
        cleanup();
        resolvePort(Number(match[1]));
      }
    };
    const onError = (error) => rejectWithCleanup(error);
    const onExit = (code, signal) => rejectWithCleanup(new Error(
      `http server exited before reporting its port (${signal ?? code ?? "unknown"})${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`,
    ));
    const timer = setTimeout(() => rejectWithCleanup(new Error("http server did not report its port")), 5_000);
    httpServer.stderr.on("data", onData);
    httpServer.once("error", onError);
    httpServer.once("exit", onExit);
  });
  const slowConnection = (trickle) => new Promise((resolveSlow) => {
    const started = Date.now();
    let settled = false;
    let interval;
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(`POST /v1/resolve HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\nx`);
      if (trickle) interval = setInterval(() => sock.write("x"), 1_000);
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (interval !== undefined) clearInterval(interval);
      resolveSlow(Date.now() - started);
    };
    sock.once("close", finish);
    sock.once("error", finish);
    const timer = setTimeout(() => {
      sock.destroy();
      finish();
    }, 30_000);
  });
  const [stalledMs, trickledMs] = await Promise.all([slowConnection(false), slowConnection(true)]);
  assert.ok(stalledMs < 15_000, `stalled body held the connection for ${stalledMs}ms`);
  assert.ok(trickledMs < 15_000, `trickling body held the connection for ${trickledMs}ms`);
  // The same server must still serve ordinary requests after both slow sockets were destroyed.
  const afterStall = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(afterStall.status, 200);
} finally {
  httpServer.kill();
}

process.stdout.write("Built CLI, MCP stdio, and HTTP runtime probes passed.\n");
