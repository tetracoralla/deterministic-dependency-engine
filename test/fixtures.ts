import type { DependencyGraph } from "../src/core/contracts.js";

export const exampleGraph: DependencyGraph = {
  schema: "agent-deps/v1",
  nodes: [
    { id: "schema" },
    { id: "backend" },
    { id: "ui", label: "UI" },
    { id: "e2e", label: "E2E" },
    { id: "release", label: "Release" },
  ],
  requires: [
    { dependent: "backend", prerequisite: "schema" },
    { dependent: "e2e", prerequisite: "backend" },
    { dependent: "e2e", prerequisite: "ui" },
    { dependent: "release", prerequisite: "e2e" },
  ],
};

export const cycleGraph: DependencyGraph = {
  schema: "agent-deps/v1",
  nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
  requires: [
    { dependent: "b", prerequisite: "a" },
    { dependent: "c", prerequisite: "b" },
    { dependent: "a", prerequisite: "c" },
  ],
};

export function shuffledGraph(seed: number): DependencyGraph {
  const shuffle = <T>(input: T[]): T[] => {
    const output = [...input];
    let state = seed + 1;
    for (let index = output.length - 1; index > 0; index -= 1) {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      const other = state % (index + 1);
      [output[index], output[other]] = [output[other] as T, output[index] as T];
    }
    return output;
  };
  return {
    schema: exampleGraph.schema,
    nodes: shuffle(exampleGraph.nodes),
    requires: shuffle(exampleGraph.requires),
  };
}
