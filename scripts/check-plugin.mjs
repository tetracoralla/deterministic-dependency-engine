import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

const manifest = JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8"));
assert.equal(manifest.name, "graph-dependency-solver");
assert.equal(manifest.skills, "./skills/");
assert.equal(manifest.mcpServers, "./.mcp.json");
assert.equal(manifest.interface.displayName, "Gridlace");
assert.ok(Array.isArray(manifest.interface.defaultPrompt));

const mcp = JSON.parse(await readFile(".mcp.json", "utf8"));
assert.equal(mcp.mcpServers.dependency_engine.command, "node");
assert.equal(mcp.mcpServers.dependency_engine.cwd, ".");
await stat("dist/adapters/mcp.js");

const skill = await readFile("skills/reason-about-dependencies/SKILL.md", "utf8");
assert.match(skill, /^---\nname: reason-about-dependencies\ndescription: .+\n---\n/u);
assert.equal(skill.includes("[TODO"), false);
assert.match(skill, /dependent.*prerequisite/su);
assert.match(skill, /never describe it as proof/u);
assert.match(skill, /Gridlace/u);

process.stdout.write("Plugin and product Skill checks passed.\n");
