import { describe, expect, it } from "vitest";
import type { DependencyGraph } from "../src/core/contracts.js";
import {
  byteLength,
  canonicalGraph,
  compareIds,
  encodeUtf8,
  hashJson,
  hashJsonParts,
} from "../src/core/canonical.js";

// Reference implementation of the previous code-point iterator comparison;
// the allocation-free scan in compareIds must agree with it on every input.
function referenceCompare(left: string, right: string): number {
  const leftIterator = left[Symbol.iterator]();
  const rightIterator = right[Symbol.iterator]();
  while (true) {
    const leftValue = leftIterator.next();
    const rightValue = rightIterator.next();
    if (leftValue.done || rightValue.done) {
      return leftValue.done === rightValue.done ? 0 : leftValue.done ? -1 : 1;
    }
    const leftCodePoint = leftValue.value.codePointAt(0) ?? 0;
    const rightCodePoint = rightValue.value.codePointAt(0) ?? 0;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint < rightCodePoint ? -1 : 1;
  }
}

describe("canonical ordering and hashing", () => {
  it("matches the code-point reference on adversarial identifier pairs", () => {
    const samples = [
      "",
      "a",
      "a\u0000",
      "ab",
      "b",
      "\u00e9",
      "e\u0301",
      "\uffff",
      "\ud83d\ude00",
      "\ud83d\udc00",
      "\ud83d\udc00a",
      "\udbff\udfff",
      "\ud800",
      "\udc00",
      "\ud800A",
      "\ud800\u0042",
      "a\ud83d\ude00b",
      "\ud83d\ude00A",
      "A\ud83d\ude00",
    ];
    for (const left of samples) {
      for (const right of samples) {
        expect(compareIds(left, right)).toBe(referenceCompare(left, right));
      }
    }
  });

  it("matches the code-point reference on pseudo-random surrogate-heavy pairs", () => {
    let state = 1_234_567_89;
    const random = (): number => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 2 ** 32;
    };
    const randomString = (): string => Array.from({ length: 1 + Math.floor(random() * 6) }, () => {
      const pick = random();
      if (pick < 0.4) return String.fromCharCode(33 + Math.floor(random() * 90));
      if (pick < 0.7) return String.fromCharCode(0x4e00 + Math.floor(random() * 200));
      if (pick < 0.9) return String.fromCodePoint(0x1f300 + Math.floor(random() * 200));
      return random() < 0.5 ? "\ud800" : "\udfff";
    }).join("");
    const randoms = Array.from({ length: 250 }, randomString);
    for (const left of randoms) {
      for (const right of randoms.slice(0, 25)) {
        expect(compareIds(left, right)).toBe(referenceCompare(left, right));
      }
    }
  });

  it("streams sha256 identically to hashing the concatenated string", () => {
    const body = encodeUtf8('{"nodes":["\\u00e9\\ud83d\\ude00","plain"]}');
    const prefix = '{"graph":';
    const suffix = ',"operation":"resolve","query":{}}';
    expect(hashJsonParts(prefix, body, suffix))
      .toBe(hashJson(prefix + new TextDecoder().decode(body) + suffix));
  });

  it("drops undefined-valued fields in the canonical copy like its stable JSON", () => {
    const raw = {
      schema: "agent-deps/v1",
      nodes: [{ id: "z", label: undefined }],
      requires: [],
    } as unknown as DependencyGraph;
    const graph = canonicalGraph(raw);
    expect(Object.hasOwn(graph.nodes[0]!, "label")).toBe(false);
    expect(byteLength(graph)).toBe(byteLength({ schema: "agent-deps/v1", nodes: [{ id: "z" }], requires: [] }));
  });
});
