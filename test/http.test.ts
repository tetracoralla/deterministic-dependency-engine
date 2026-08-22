import { describe, expect, it } from "vitest";
import { handleHttpRequest, statusForError } from "../src/adapters/http-worker.js";
import { exampleGraph } from "./fixtures.js";

describe("HTTP adapter", () => {
  it("maps engine error codes to stable HTTP statuses", () => {
    expect(statusForError("REQUEST_TOO_LARGE")).toBe(413);
    expect(statusForError("RESPONSE_TOO_LARGE")).toBe(413);
    expect(statusForError("DEPENDENCY_CYCLE")).toBe(409);
    expect(statusForError("TIMEOUT")).toBe(408);
    expect(statusForError("SERVER_BUSY")).toBe(503);
    expect(statusForError("INTERNAL_ERROR")).toBe(500);
    expect(statusForError("INVALID_REQUEST")).toBe(400);
  });

  it("serves health and operation routes through the shared core", async () => {
    const health = await handleHttpRequest(new Request("http://local/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", service: "dependency-engine" });

    const healthHead = await handleHttpRequest(new Request("http://local/health", { method: "HEAD" }));
    expect(healthHead.status).toBe(200);
    expect(await healthHead.text()).toBe("");

    const response = await handleHttpRequest(new Request("http://local/v1/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ graph: exampleGraph, targets: ["release"], satisfied: ["schema", "backend"] }),
    }));
    expect(response.status).toBe(200);
    const result = await response.json() as { kind?: string; ready?: string[] };
    expect(result.kind).toBe("resolution");
    expect(result.ready).toEqual(["ui"]);
  });

  it("distinguishes unknown routes from wrong methods", async () => {
    const wrongMethod = await handleHttpRequest(new Request("http://local/v1/resolve"));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
    expect(((await wrongMethod.json()) as { error?: { code?: string } }).error?.code)
      .toBe("METHOD_NOT_ALLOWED");

    const unknownRoute = await handleHttpRequest(new Request("http://local/v1/nope", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));
    expect(unknownRoute.status).toBe(404);
  });

  it("rejects non-GET methods on /health with an explicit allow header", async () => {
    const wrongMethod = await handleHttpRequest(new Request("http://local/health", { method: "POST" }));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET, HEAD");
    expect(((await wrongMethod.json()) as { error?: { code?: string } }).error?.code)
      .toBe("METHOD_NOT_ALLOWED");
  });

  it("rejects wrong media types and malformed JSON", async () => {
    const wrongType = await handleHttpRequest(new Request("http://local/v1/resolve", {
      method: "POST",
      body: "{}",
    }));
    expect(wrongType.status).toBe(415);

    const lookalikeJson = await handleHttpRequest(new Request("http://local/v1/resolve", {
      method: "POST",
      headers: { "content-type": "application/jsonp" },
      body: "{}",
    }));
    expect(lookalikeJson.status).toBe(415);

    const malformed = await handleHttpRequest(new Request("http://local/v1/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }));
    expect(malformed.status).toBe(400);
  });

  it("bounds a streamed body without relying on Content-Length and then recovers", async () => {
    const oversized = await handleHttpRequest(new Request("http://local/v1/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(262_145),
    }));
    expect(oversized.status).toBe(413);
    expect(((await oversized.json()) as { error?: { code?: string } }).error?.code)
      .toBe("REQUEST_TOO_LARGE");

    const recovered = await handleHttpRequest(new Request("http://local/v1/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ graph: exampleGraph, targets: ["release"], satisfied: ["schema", "backend"] }),
    }));
    expect(recovered.status).toBe(200);
  });

  it("counts pre-handler body time in the logical HTTP deadline", async () => {
    const response = await handleHttpRequest(new Request("http://local/v1/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        graph: exampleGraph,
        targets: ["release"],
        satisfied: [],
        limits: { timeout_ms: 10 },
      }),
    }), performance.now() - 20);
    expect(response.status).toBe(408);
    expect(((await response.json()) as { error?: { code?: string } }).error?.code).toBe("TIMEOUT");
  });
});
