import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  ErrorResultSchema,
  ExplainRequestSchema,
  ExplainResultSchema,
  ImpactRequestSchema,
  ImpactResultSchema,
  ResolveRequestSchema,
  ResolveResultSchema,
  SliceRequestSchema,
  SliceResultSchema,
  ValidateRequestSchema,
  ValidateResultSchema,
} from "../src/core/contracts.js";

const schemas = {
  "validate.request.schema.json": ValidateRequestSchema,
  "validate.result.schema.json": z.union([ValidateResultSchema, ErrorResultSchema]),
  "resolve.request.schema.json": ResolveRequestSchema,
  "resolve.result.schema.json": z.union([ResolveResultSchema, ErrorResultSchema]),
  "impact.request.schema.json": ImpactRequestSchema,
  "impact.result.schema.json": z.union([ImpactResultSchema, ErrorResultSchema]),
  "slice.request.schema.json": SliceRequestSchema,
  "slice.result.schema.json": z.union([SliceResultSchema, ErrorResultSchema]),
  "explain.request.schema.json": ExplainRequestSchema,
  "explain.result.schema.json": z.union([ExplainResultSchema, ErrorResultSchema]),
} as const;

const check = process.argv.includes("--check");
let drift = false;

for (const [filename, schema] of Object.entries(schemas)) {
  const path = resolve("schemas", filename);
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-7", reused: "ref" });
  const content = `${JSON.stringify({
    $id: `https://openadam.dev/dependency-engine/${filename}`,
    ...jsonSchema,
  }, null, 2)}\n`;
  if (check) {
    let current = "";
    try {
      current = await readFile(path, "utf8");
    } catch {
      // Missing files are schema drift.
    }
    if (current !== content) {
      process.stderr.write(`Schema drift: ${filename}\n`);
      drift = true;
    }
  } else {
    await writeFile(path, content, "utf8");
  }
}

if (drift) process.exitCode = 1;
