import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isMainModule } from "../src/adapters/main-module.js";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("installed executable entry detection", () => {
  it("recognizes a package bin symlink as the main module", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dependency-engine-main-"));
    created.push(directory);
    const target = join(directory, "cli.js");
    const link = join(directory, "dependency-engine");
    await writeFile(target, "#!/usr/bin/env node\n", "utf8");
    await symlink(target, link);
    expect(isMainModule(pathToFileURL(target).href, link)).toBe(true);
  });
});
