import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { DependencyGraph, DependencyRelation } from "./contracts.js";

const textEncoder = new TextEncoder();

function compareCodePoints(left: string, right: string): number {
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

// Code-unit order equals code-point order except where surrogate code units
// (U+D800..U+DFFF) are involved, so the allocation-free unit scan decides
// directly and only strings that diverge at a surrogate fall back to the
// code-point iterator walk.
export function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  const sharedLength = left.length < right.length ? left.length : right.length;
  for (let index = 0; index < sharedLength; index += 1) {
    const leftUnit = left.charCodeAt(index);
    const rightUnit = right.charCodeAt(index);
    if (leftUnit === rightUnit) continue;
    if ((leftUnit & 0xf800) === 0xd800 || (rightUnit & 0xf800) === 0xd800) {
      return compareCodePoints(left, right);
    }
    return leftUnit < rightUnit ? -1 : 1;
  }
  return left.length < right.length ? -1 : 1;
}

export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareIds);
}

function relationCompare(left: DependencyRelation, right: DependencyRelation): number {
  return compareIds(left.dependent, right.dependent) || compareIds(left.prerequisite, right.prerequisite);
}

function optionalTextCompare(left: string | undefined, right: string | undefined): number {
  if (left === undefined || right === undefined) {
    return left === right ? 0 : left === undefined ? -1 : 1;
  }
  return compareIds(left, right);
}

function copyDefinedFields<T extends object>(value: T): T {
  const copy: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field !== undefined) copy[key] = field;
  }
  return copy as T;
}

export function canonicalGraph(graph: DependencyGraph): DependencyGraph {
  return {
    schema: graph.schema,
    // The canonical copy drops undefined-valued fields so a graph's structure
    // matches its stable JSON serialization exactly; shapes that differ only
    // by an undefined field must not diverge while sharing compiled state.
    nodes: [...graph.nodes]
      .map((node) => copyDefinedFields(node))
      .sort((left, right) => compareIds(left.id, right.id) || optionalTextCompare(left.label, right.label)),
    requires: [...graph.requires]
      .map((relation) => copyDefinedFields(relation))
      .sort(relationCompare),
  };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compareIds(left, right))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function encodeUtf8(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function hashBytes(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function hashJson(json: string): string {
  return hashBytes(encodeUtf8(json));
}

/** Hashes prefix + body + suffix without materializing their concatenation. */
export function hashJsonParts(prefix: string, body: Uint8Array, suffix: string): string {
  const digest = sha256.create()
    .update(encodeUtf8(prefix))
    .update(body)
    .update(encodeUtf8(suffix));
  return bytesToHex(digest.digest());
}

export function hashValue(value: unknown): string {
  return hashJson(stableJson(value));
}

export function byteLength(value: unknown): number {
  return encodeUtf8(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
}
