import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const files = (await readdir("schemas")).filter((file) => file.endsWith(".schema.json")).sort();
assert.equal(files.length, 10, "five request and five result schemas must be published");

for (const file of files) {
  const schema = JSON.parse(await readFile(resolve("schemas", file), "utf8"));
  assert.equal(typeof schema.$id, "string", `${file} needs a stable id`);
  if (file.endsWith("request.schema.json")) {
    const serialized = JSON.stringify(schema);
    assert.equal(serialized.includes('"from"'), false, `${file} must not publish ambiguous from`);
    assert.equal(serialized.includes('"to"'), false, `${file} must not publish ambiguous to`);
  }
}

const manifest = JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8"));
assert.equal(manifest.name, "graph-dependency-solver");
assert.equal(manifest.version, "0.1.0");
assert.equal(manifest.skills, "./skills/");
assert.equal(manifest.mcpServers, "./.mcp.json");
assert.deepEqual(manifest.author, { name: "openAdam", url: "https://github.com/tetracoralla" });
assert.equal(manifest.repository, "https://github.com/tetracoralla/Gridlace");

const packageManifest = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(packageManifest.name, "@openadam/dependency-engine");
assert.equal(packageManifest.author, "openAdam");
assert.equal(packageManifest.private, true, "the source package is not published to npm");
assert.equal(packageManifest.repository?.url, "git+https://github.com/tetracoralla/Gridlace.git");
assert.deepEqual(Object.keys(packageManifest.bin).sort(), [
  "dependency-engine",
  "dependency-engine-http",
  "dependency-engine-mcp",
]);
assert.equal(
  packageManifest.files.includes("design/gridlace-concept.png"),
  true,
  "the packaged README image must be included in the distribution",
);

const contracts = await readFile("src/core/contracts.ts", "utf8");
const productName = /^export const PRODUCT_NAME = "([^"]+)";$/mu.exec(contracts)?.[1];
const productSubtitle = /^export const PRODUCT_SUBTITLE = "([^"]+)";$/mu.exec(contracts)?.[1];
assert.equal(productName, "Gridlace");
assert.equal(productSubtitle, "A Deterministic Dependency Engine");
assert.match(contracts, /ENGINE_NAME = "dependency-engine"/u);
assert.match(contracts, /GRAPH_SCHEMA_VERSION = "agent-deps\/v1"/u);
assert.equal(manifest.interface.displayName, productName);

const brandSurfaces = [
  "AGENTS.md",
  "README.md",
  "CONTRIBUTING.md",
  "docs/PRODUCT_IDENTITY.md",
  "docs/PRODUCT_MODEL.md",
  "index.html",
  "NOTICE",
  "skills/reason-about-dependencies/SKILL.md",
];
for (const file of brandSurfaces) {
  assert.equal(
    (await readFile(file, "utf8")).includes(productName),
    true,
    `${file} must use the canonical display brand`,
  );
}

assert.equal(packageManifest.description.includes(productName), true, "package description must use the display brand");
assert.equal(manifest.description.includes(productName), true, "plugin description must use the display brand");

const indexHtml = await readFile("index.html", "utf8");
assert.equal(
  /<title>([^<]+)<\/title>/u.exec(indexHtml)?.[1],
  `${productName} — ${productSubtitle}`,
  "index.html title must mirror the product identity constants",
);

const app = await readFile("src/ui/App.tsx", "utf8");
assert.match(app, /<h1[^>]*>\s*\{PRODUCT_NAME\}\s*<\/h1>/u, "App.tsx must render the header through PRODUCT_NAME");

const mcp = JSON.parse(await readFile(".mcp.json", "utf8"));
assert.deepEqual(mcp.mcpServers.dependency_engine.args, ["./dist/adapters/mcp.js"]);

const source = await readFile("src/adapters/mcp.ts", "utf8");
for (const name of ["graph_validate", "dependency_resolve", "dependency_impact", "dependency_slice", "dependency_explain"]) {
  assert.match(source, new RegExp(`name:\\s*\\"${name}\\"`));
}
assert.equal(source.includes("ListToolsRequestSchema"), true);
assert.equal(source.includes("CallToolRequestSchema"), true);
assert.equal(source.includes("z.toJSONSchema"), true);
assert.equal(source.includes("readOnlyHint: true"), true);
assert.equal(source.includes("destructiveHint: false"), true);
assert.equal(source.includes("idempotentHint: true"), true);
assert.equal(source.includes("openWorldHint: false"), true);

process.stdout.write("Contract checks passed.\n");
