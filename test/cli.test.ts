import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENGINE_VERSION, HARD_LIMITS, PRODUCT_NAME, PRODUCT_SUBTITLE } from "../src/core/contracts.js";
import { byteLength } from "../src/core/canonical.js";
import { runOperation } from "../src/core/engine.js";
import { main, serializeCliResult } from "../src/adapters/cli.js";
import { exampleGraph } from "./fixtures.js";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

function captureStdout(): string[] {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  return chunks;
}

describe("CLI adapter", () => {
  it("shows the product brand while preserving the stable command name", async () => {
    const chunks = captureStdout();
    const code = await main(["--help"]);
    expect(code).toBe(0);
    expect(chunks.join("")).toContain(`${PRODUCT_NAME} ${ENGINE_VERSION}`);
    expect(chunks.join("")).toContain(PRODUCT_SUBTITLE);
    expect(chunks.join("")).toContain("dependency-engine <validate|resolve|impact|slice|explain>");
  });

  it("reports a missing operation as CLI usage, not a request-schema error", async () => {
    const chunks = captureStdout();
    const code = await main(["--input", "-"]);
    expect(code).toBe(1);
    const result = JSON.parse(chunks.join("")) as { error?: { code?: string; message?: string } };
    expect(result.error?.code).toBe("CLI_USAGE");
    expect(result.error?.message).toContain("exactly one operation");
  });

  it("reports an unknown operation as CLI usage", async () => {
    const chunks = captureStdout();
    const code = await main(["frobnicate"]);
    expect(code).toBe(1);
    const result = JSON.parse(chunks.join("")) as { error?: { code?: string } };
    expect(result.error?.code).toBe("CLI_USAGE");
  });

  it("classifies oversized input files as REQUEST_TOO_LARGE", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dependency-engine-cli-"));
    created.push(directory);
    const path = join(directory, "big.json");
    await writeFile(path, "x".repeat(HARD_LIMITS.maxRequestBytes + 1), "utf8");
    const chunks = captureStdout();
    const code = await main(["resolve", "--input", path]);
    expect(code).toBe(1);
    const result = JSON.parse(chunks.join("")) as { error?: { code?: string } };
    expect(result.error?.code).toBe("REQUEST_TOO_LARGE");
  });

  it("reads a request from standard input when --input is omitted", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx", resolve("src/adapters/cli.ts"), "resolve"], {
      cwd: process.cwd(),
      input: JSON.stringify({ graph: exampleGraph, targets: ["release"], satisfied: ["schema", "backend"] }),
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(run.status).toBe(0);
    expect((JSON.parse(run.stdout) as { ready?: string[] }).ready).toEqual(["ui"]);
  });

  it("delivers a compact result exactly at the selected response limit", () => {
    const input = { graph: exampleGraph, targets: ["release"], satisfied: [] };
    const result = runOperation("resolve", input);
    expect(result.status).toBe("ok");
    const atLimit = { ...input, limits: { max_response_bytes: byteLength(result) } };
    const serialized = serializeCliResult(result, atLimit, false);
    expect(serialized.result.status).toBe("ok");
    expect(serialized.text.endsWith("\n")).toBe(true);
    expect(JSON.parse(serialized.text)).toEqual(result);
    expect(Buffer.byteLength(serialized.text) - 1).toBe(byteLength(result));
  });

  it("still bounds pretty formatting that exceeds the selected response limit", () => {
    const nodes = Array.from({ length: 1600 }, (_, index) => ({ id: `node-${String(index).padStart(4, "0")}` }));
    nodes.push({ id: "target" });
    const input = {
      graph: {
        schema: "agent-deps/v1" as const,
        nodes,
        requires: nodes.slice(0, 1600).map((node) => ({ dependent: "target", prerequisite: node.id })),
      },
      targets: ["target"],
      satisfied: [],
    };
    const result = runOperation("resolve", input);
    expect(result.status).toBe("ok");
    const tight = { ...input, limits: { max_response_bytes: byteLength(result) } };
    const serialized = serializeCliResult(result, tight, true);
    expect(serialized.result.status).toBe("error");
    if (serialized.result.status === "error") {
      expect(serialized.result.error.code).toBe("RESPONSE_TOO_LARGE");
    }
  });
});
