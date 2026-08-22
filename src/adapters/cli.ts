#!/usr/bin/env node
import { open, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  ENGINE_VERSION,
  HARD_LIMITS,
  OperationSchema,
  PRODUCT_NAME,
  PRODUCT_SUBTITLE,
  type Operation,
} from "../core/contracts.js";
import type { EngineResult } from "../core/contracts.js";
import { deadlineExceeded, responseLimitFromInput } from "../core/budget.js";
import { byteLength } from "../core/canonical.js";
import { runOperation } from "../core/engine.js";
import { EngineError, errorResult, responseTooLargeResult, timeoutResult } from "../core/errors.js";
import { isMainModule } from "./main-module.js";

const HELP = `${PRODUCT_NAME} ${ENGINE_VERSION}
${PRODUCT_SUBTITLE}

Usage:
  dependency-engine <validate|resolve|impact|slice|explain> [--input FILE|-] [--pretty]

The input is one operation-specific JSON request. Standard input is used when
--input is omitted or set to -. Results are written as JSON to standard output.
`;

async function readChunksBounded(source: AsyncIterable<string | Uint8Array>): Promise<string> {
  const body = Buffer.allocUnsafe(HARD_LIMITS.maxRequestBytes);
  let total = 0;
  for await (const chunkValue of source) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue as string);
    const nextTotal = total + chunk.byteLength;
    if (nextTotal > HARD_LIMITS.maxRequestBytes) {
      throw new EngineError(
        "REQUEST_TOO_LARGE",
        `Input exceeds ${HARD_LIMITS.maxRequestBytes} bytes.`,
        { actual_bytes: nextTotal, max_request_bytes: HARD_LIMITS.maxRequestBytes },
      );
    }
    chunk.copy(body, total);
    total = nextTotal;
  }
  return body.subarray(0, total).toString("utf8");
}

async function readStdinBounded(): Promise<string> {
  return readChunksBounded(process.stdin);
}

async function readInput(path: string | undefined): Promise<string> {
  if (path === undefined || path === "-") return readStdinBounded();
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("--input must name a regular file.");
  if (metadata.size > HARD_LIMITS.maxRequestBytes) {
    throw new EngineError(
      "REQUEST_TOO_LARGE",
      `Input exceeds ${HARD_LIMITS.maxRequestBytes} bytes.`,
      { actual_bytes: metadata.size, max_request_bytes: HARD_LIMITS.maxRequestBytes },
    );
  }
  const handle = await open(path, "r");
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()) throw new Error("--input must name a regular file.");
    if (openedMetadata.size > HARD_LIMITS.maxRequestBytes) {
      throw new EngineError(
        "REQUEST_TOO_LARGE",
        `Input exceeds ${HARD_LIMITS.maxRequestBytes} bytes.`,
        { actual_bytes: openedMetadata.size, max_request_bytes: HARD_LIMITS.maxRequestBytes },
      );
    }
    return await readChunksBounded(handle.createReadStream({ autoClose: false }));
  } finally {
    await handle.close();
  }
}

export function serializeCliResult(
  result: EngineResult,
  input: unknown,
  pretty: boolean,
): { result: EngineResult; text: string } {
  const maxResponseBytes = responseLimitFromInput(input);
  let text = `${JSON.stringify(result, null, pretty ? 2 : undefined)}\n`;
  // The trailing newline is CLI framing, not part of the serialized result, so a
  // result exactly at the limit stays deliverable exactly like the other carriers.
  const actualBytes = byteLength(text) - 1;
  if (actualBytes <= maxResponseBytes) return { result, text };
  const bounded = responseTooLargeResult(
    actualBytes,
    maxResponseBytes,
    result.status === "error" ? result.error.code : undefined,
  );
  text = `${JSON.stringify(bounded, null, pretty ? 2 : undefined)}\n`;
  return { result: bounded, text };
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const startedAt = performance.now();
  try {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        input: { type: "string", short: "i" },
        pretty: { type: "boolean", short: "p", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
    if (parsed.values.help) {
      process.stdout.write(HELP);
      return 0;
    }
    if (parsed.values.version) {
      process.stdout.write(`${ENGINE_VERSION}\n`);
      return 0;
    }
    if (parsed.positionals.length !== 1) throw new Error("Provide exactly one operation.");
    const operationParsed = OperationSchema.safeParse(parsed.positionals[0]);
    if (!operationParsed.success) {
      throw new Error("Unknown operation. Use validate, resolve, impact, slice, or explain.");
    }
    const operation = operationParsed.data as Operation;
    const source = await readInput(parsed.values.input);
    let input: unknown;
    try {
      input = JSON.parse(source);
    } catch {
      const result = errorResult(new Error("Invalid JSON input."));
      result.error.code = "INVALID_JSON";
      result.error.message = "The input is not valid JSON.";
      process.stdout.write(`${JSON.stringify(result, null, parsed.values.pretty ? 2 : undefined)}\n`);
      return 1;
    }
    const result = runOperation(operation, input, startedAt);
    let serialized = serializeCliResult(result, input, parsed.values.pretty);
    if (deadlineExceeded(input, startedAt)) {
      serialized = serializeCliResult(
        timeoutResult(responseLimitFromInput(input)),
        input,
        parsed.values.pretty,
      );
    }
    process.stdout.write(serialized.text);
    return serialized.result.status === "error" ? 1 : 0;
  } catch (error) {
    const result = errorResult(error);
    if (result.error.code === "INTERNAL_ERROR") {
      result.error.code = "CLI_USAGE";
      result.error.message = error instanceof Error ? error.message : "Invalid CLI usage.";
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  }).catch(() => {
    process.exitCode = 1;
  });
}
