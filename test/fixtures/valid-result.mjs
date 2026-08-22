export function validResolution() {
  return {
    status: "ok",
    kind: "resolution",
    targets: [],
    satisfied: [],
    required: [],
    remaining: [],
    ready: [],
    execution_layers: [],
    blocked: [],
    root_blockers: [],
    receipt: {
      engine: "dependency-engine",
      version: "0.1.0",
      operation: "resolve",
      graph_hash: "0".repeat(64),
      request_hash: "0".repeat(64),
      result_hash: "0".repeat(64),
    },
  };
}
