import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const dependency = "file:vendor/openadam-graph-view-compiler-0.3.0.tgz";
const filename = "openadam-graph-view-compiler-0.3.0.tgz";
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const tarball = await readFile(`vendor/${filename}`);
const checksum = (await readFile(`vendor/${filename}.sha256`, "utf8")).trim().split(/\s+/u);
const installed = JSON.parse(await readFile(
  "node_modules/@openadam/graph-view-compiler/package.json",
  "utf8",
));

assert.equal(manifest.dependencies["@openadam/graph-view-compiler"], dependency);
assert.equal(lock.packages[""].dependencies["@openadam/graph-view-compiler"], dependency);
assert.equal(checksum[1], filename);
assert.match(checksum[0], /^[a-f0-9]{64}$/u);
assert.equal(createHash("sha256").update(tarball).digest("hex"), checksum[0]);
assert.equal(installed.name, "@openadam/graph-view-compiler");
assert.equal(installed.version, "0.3.0");

const projection = await import("@openadam/graph-view-compiler/semantic");
assert.equal(projection.SEMANTIC_GRAPH_VERSION, 1);
assert.equal(typeof projection.sliceSemanticGraph, "function");

process.stdout.write("Graph View Compiler package checks passed.\n");
