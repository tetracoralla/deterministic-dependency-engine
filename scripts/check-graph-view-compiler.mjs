import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const dependency = "0.4.0";
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const locked = lock.packages["node_modules/@openadam/graph-view-compiler"];
const installed = JSON.parse(await readFile(
  "node_modules/@openadam/graph-view-compiler/package.json",
  "utf8",
));

assert.equal(manifest.dependencies["@openadam/graph-view-compiler"], dependency);
assert.equal(lock.packages[""].dependencies["@openadam/graph-view-compiler"], dependency);
assert.equal(locked.version, dependency);
assert.match(locked.resolved, /^https:\/\/registry\.npmjs\.org\/@openadam\/graph-view-compiler\/-\//u);
assert.match(locked.integrity, /^sha512-/u);
assert.equal(installed.name, "@openadam/graph-view-compiler");
assert.equal(installed.version, dependency);

const projection = await import("@openadam/graph-view-compiler/semantic");
assert.equal(projection.SEMANTIC_GRAPH_VERSION, 1);
assert.equal(typeof projection.sliceSemanticGraph, "function");

process.stdout.write("Graph View Compiler package checks passed.\n");
