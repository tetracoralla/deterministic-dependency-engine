import type { DependencyGraph } from "../core/contracts.js";

export const EXAMPLE_GRAPH: DependencyGraph = {
  schema: "agent-deps/v1",
  nodes: [
    { id: "schema", label: "Schema" },
    { id: "backend", label: "Backend" },
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

export const EXAMPLE_SOURCE = `{
  "schema": "agent-deps/v1",
  "nodes": [
    { "id": "schema", "label": "Schema" },
    { "id": "backend", "label": "Backend" },
    { "id": "ui", "label": "UI" },
    { "id": "e2e", "label": "E2E" },
    { "id": "release", "label": "Release" }
  ],
  "requires": [
    { "dependent": "backend", "prerequisite": "schema" },
    { "dependent": "e2e", "prerequisite": "backend" },
    { "dependent": "e2e", "prerequisite": "ui" },
    { "dependent": "release", "prerequisite": "e2e" }
  ]
}`;
