import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MCP_ENTRY = resolve("src/adapters/mcp.ts");

function spawnServer(): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolveExit, rejectExit) => {
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => rejectExit(new Error(`server did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit({ code, stderr });
    });
  });
}

function readLine(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolveLine, rejectLine) => {
    let buffer = "";
    const timer = setTimeout(() => rejectLine(new Error(`no stdout line within ${timeoutMs}ms`)), timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      resolveLine(buffer.slice(0, newline));
    };
    child.stdout?.on("data", onData);
  });
}

describe("MCP stdio transport bounds", () => {
  it("rejects a runaway multi-megabyte message at the transport, then rebuilds cleanly", async () => {
    const oversized = spawnServer();
    // Swallow the EPIPE that follows the server discarding the connection.
    oversized.stdin?.on("error", () => undefined);
    const exited = waitForExit(oversized, 10_000);
    oversized.stdin?.write(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"dependency_resolve","arguments":{"padding":"${"x".repeat(8 * 1024 * 1024)}"}}}\n`);
    oversized.stdin?.end();
    const { code, stderr } = await exited;
    // The over-limit connection is closed promptly with a logged reason; the
    // host restarts the server instead of the server buffering the payload.
    expect(code).toBe(0);
    expect(stderr).toContain("transport closed");
    expect(stderr).toContain("exceeded maximum size");

    // A fresh server process serves ordinary traffic after the rebuild.
    const rebuilt = spawnServer();
    try {
      const line = readLine(rebuilt, 10_000);
      rebuilt.stdin?.write('{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n');
      const response = await line;
      expect(response).toContain('"graph_validate"');
      expect(response).toContain('"dependency_explain"');
    } finally {
      rebuilt.kill();
    }
  }, 25_000);

  it("still answers stable REQUEST_TOO_LARGE inside the transport bound", async () => {
    const child = spawnServer();
    try {
      const line = readLine(child, 10_000);
      // 300KB of arguments passes the transport buffer (262KB + framing slack)
      // but exceeds the core request limit, which must answer as a structured
      // error without killing the connection.
      child.stdin?.write(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"dependency_resolve","arguments":{"padding":"${"x".repeat(300_000)}"}}}\n`);
      const response = JSON.parse(await line) as { id?: number; result?: { isError?: boolean; structuredContent?: { result?: { error?: { code?: string } } } } };
      expect(response.id).toBe(3);
      expect(response.result?.isError).toBe(true);
      expect(response.result?.structuredContent?.result?.error?.code).toBe("REQUEST_TOO_LARGE");
      // The same connection keeps serving afterwards.
      const followUp = readLine(child, 10_000);
      child.stdin?.write('{"jsonrpc":"2.0","id":8,"method":"tools/list"}\n');
      expect(await followUp).toContain('"graph_validate"');
    } finally {
      child.kill();
    }
  }, 25_000);
});
