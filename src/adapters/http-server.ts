#!/usr/bin/env node
import { createServer, type IncomingMessage } from "node:http";
import { parseArgs } from "node:util";
import { HARD_LIMITS, PRODUCT_NAME } from "../core/contracts.js";
import { isMainModule } from "./main-module.js";
import { handleHttpRequest } from "./http-worker.js";

// The engine may spend the full maxTimeoutMs producing a structured TIMEOUT
// result; a short grace margin on every socket-level ceiling keeps that
// response deliverable instead of losing the connection mid-flush.
const HTTP_CEILING_MS = HARD_LIMITS.maxTimeoutMs + 250;

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    total += chunk.byteLength;
    if (total > HARD_LIMITS.maxRequestBytes) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs({
    args,
    strict: true,
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8787" },
    },
  });
  const port = Number(parsed.values.port);
  // Port 0 asks the operating system for a free port.
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be 0-65535.");
  const server = createServer({
    headersTimeout: HTTP_CEILING_MS,
    requestTimeout: HTTP_CEILING_MS,
    connectionsCheckingInterval: Math.min(1_000, HARD_LIMITS.maxTimeoutMs),
  }, async (incoming, outgoing) => {
    const startedAt = performance.now();
    // Node's server-level request timeout is checked on an interval and has
    // proven insufficiently deterministic for bodies that stall after their
    // headers arrive. Enforce the same hard ceiling per request as soon as the
    // handler owns the connection.
    const requestDeadline = setTimeout(() => outgoing.destroy(), HTTP_CEILING_MS);
    requestDeadline.unref();
    try {
      const body = await readBody(incoming);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      let request: Request;
      try {
        request = new Request(`http://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`, {
          method: incoming.method ?? "GET",
          headers,
          ...(incoming.method === "GET" || incoming.method === "HEAD" ? {} : { body: body as BodyInit }),
        });
      } catch {
        // Absolute-form or otherwise malformed request-targets cannot become a
        // WHATWG Request; answer structurally instead of surfacing a 500.
        outgoing.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        outgoing.end(JSON.stringify({
          status: "error",
          error: { code: "INVALID_REQUEST", message: "Malformed HTTP request target." },
        }));
        return;
      }
      const response = await handleHttpRequest(request, startedAt);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (outgoing.destroyed) return;
      // A failure after the status line was written cannot be answered with
      // another one; destroying the socket keeps this handler from throwing
      // ERR_HTTP_HEADERS_SENT and taking the whole process down.
      if (outgoing.headersSent) {
        outgoing.destroy();
        return;
      }
      const oversized = error instanceof Error && error.message === "REQUEST_TOO_LARGE";
      outgoing.writeHead(oversized ? 413 : 500, { "content-type": "application/json; charset=utf-8" });
      outgoing.end(JSON.stringify({
        status: "error",
        error: {
          code: oversized ? "REQUEST_TOO_LARGE" : "INTERNAL_ERROR",
          message: oversized ? `Request exceeds ${HARD_LIMITS.maxRequestBytes} bytes.` : "HTTP request failed.",
        },
      }));
    } finally {
      clearTimeout(requestDeadline);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, parsed.values.host, () => resolve());
  });
  // Full-request timeout covers trickling bodies; the socket idle timeout covers
  // a body that stops mid-stream. A short check interval keeps both close to the
  // engine's hard wall-clock limit rather than Node's much larger default cadence.
  server.setTimeout(HTTP_CEILING_MS, (socket) => socket.destroy());
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  if (parsed.values.host !== "127.0.0.1" && parsed.values.host !== "localhost" && parsed.values.host !== "::1") {
    process.stderr.write(`${PRODUCT_NAME} HTTP bound to ${parsed.values.host}, which is not loopback. The adapter has no authentication, authorization, or TLS; do not expose it to an untrusted network.\n`);
  }
  process.stderr.write(`${PRODUCT_NAME} HTTP listening on http://${parsed.values.host}:${actualPort}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "HTTP server failed"}\n`);
    process.exitCode = 1;
  });
}
