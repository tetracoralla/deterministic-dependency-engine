import type { DependencyGraph, GraphIssue } from "./contracts.js";
import { byteLength, canonicalGraph, encodeUtf8, hashBytes, stableJson } from "./canonical.js";
import { buildGraphIndex, findGraphIssues, type GraphIndex } from "./graph.js";

export interface CompiledGraph {
  /** The canonical (code-point sorted, copied) form of the declared graph. */
  graph: DependencyGraph;
  /** Structural declaration issues; empty when the graph is well-formed. */
  issues: GraphIssue[];
  /** Adjacency index over the canonical graph. */
  index: GraphIndex;
  /** UTF-8 bytes of the stable canonical serialization, reused by every receipt hash. */
  canonicalBytes: Uint8Array;
  graphHash: string;
  /** UTF-8 size of the canonical serialization, used for cache accounting. */
  byteSize: number;
}

// Compiled graphs hold the canonical form, the adjacency index, and the stable
// serialization together so repeated calls over the same declared graph pay for
// normalization, indexing, and hashing once. Accounting covers the raw lookup
// key plus the canonical bytes; the retained graph objects and index maps are
// bounded separately by the entry cap. Entries expire after an idle TTL.
const CACHE_MAX_ENTRIES = 64;
const CACHE_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const CACHE_IDLE_TTL_MS = 60_000;

interface CacheEntry {
  compiled: CompiledGraph;
  keyBytes: number;
  lastAccess: number;
}

const cache = new Map<string, CacheEntry>();
let cacheTotalBytes = 0;

function rawGraphKey(graph: DependencyGraph): string | null {
  try {
    return JSON.stringify(graph);
  } catch {
    // Cyclic or otherwise unserializable input cannot be cached; compilation
    // below surfaces the same failure through the normal error path.
    return null;
  }
}

function entryBytes(entry: CacheEntry): number {
  return entry.keyBytes + entry.compiled.byteSize;
}

function dropExpired(now: number): void {
  for (const [key, entry] of cache) {
    if (now - entry.lastAccess > CACHE_IDLE_TTL_MS) {
      cache.delete(key);
      cacheTotalBytes -= entryBytes(entry);
    }
  }
}

function evictCache(): void {
  while (cache.size > CACHE_MAX_ENTRIES || cacheTotalBytes > CACHE_MAX_TOTAL_BYTES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const entry = cache.get(oldest.value);
    cache.delete(oldest.value);
    if (entry !== undefined) cacheTotalBytes -= entryBytes(entry);
  }
}

export function compileGraph(raw: DependencyGraph): CompiledGraph {
  const graph = canonicalGraph(raw);
  const canonicalBytes = encodeUtf8(stableJson(graph));
  return {
    graph,
    issues: findGraphIssues(graph),
    index: buildGraphIndex(graph),
    canonicalBytes,
    graphHash: hashBytes(canonicalBytes),
    byteSize: canonicalBytes.byteLength,
  };
}

export function getCompiledGraph(raw: DependencyGraph): CompiledGraph {
  const key = rawGraphKey(raw);
  const now = Date.now();
  if (key !== null) {
    const hit = cache.get(key);
    if (hit !== undefined) {
      if (now - hit.lastAccess <= CACHE_IDLE_TTL_MS) {
        cache.delete(key);
        cache.set(key, hit);
        hit.lastAccess = now;
        return hit.compiled;
      }
      cache.delete(key);
      cacheTotalBytes -= entryBytes(hit);
    }
  }
  const compiled = compileGraph(raw);
  // Only well-formed graphs are worth caching; issue-carrying declarations are
  // diagnostics, not repeated hot-path work.
  if (key !== null && compiled.issues.length === 0) {
    dropExpired(now);
    const entry: CacheEntry = { compiled, keyBytes: byteLength(key), lastAccess: now };
    cache.set(key, entry);
    cacheTotalBytes += entryBytes(entry);
    evictCache();
  }
  return compiled;
}
