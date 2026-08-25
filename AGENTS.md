# Deterministic Dependency Engine repository contract

Before any review, read `docs/REVIEW_CONTRACT.md`. A plain owner request to
review, audit, 审核, or 复核 invokes that contract end to end; treat it as the
minimum scope and report `tools-dev workspace escalations` without asking the
owner for another checklist.

This repository owns a deterministic dependency-reasoning product. Product
identity lives in `docs/PRODUCT_IDENTITY.md`; product meaning
lives in `docs/PRODUCT_MODEL.md`; current executable Zod models and tests are
the runtime authority.

## Invariants

- The engine proves derivations over declared relations, never the truth of
  those relations.
- Public dependency edges are always named `dependent` and `prerequisite`.
  Do not expose ambiguous `from` / `to` input fields.
- Graph structure, current satisfied facts, and the query remain separate.
- Equal candidates use code-point ordering. Input array order must not change a
  canonical result.
- V1 is a directed dependency reasoning engine. Do not add alternatives,
  conflicts, version ranges, provider selection, SAT/SMT, task execution,
  graph discovery, a graph database, or a visual graph editor without a new
  owner requirement.
- The authorized sphere viewer is a human-only, read-only projection. Keep
  camera state, coordinates, styles, focus, and rendering details out of the
  public graph, result, receipt, CLI, HTTP, MCP, and Skill contracts.
- Keep the transparent sphere as the dominant human surface. Source and
  Analysis are progressively disclosed exact-data layers, not competing default
  panels; the sphere must never imply an inferred or persisted spatial truth.
- Keep canvas chrome as bounded edge controls and overlays, not full-width bars
  or layout columns that resize the spatial graph.
- Library, CLI, MCP, HTTP, and UI call the same core operations. Adapters do not
  reimplement graph semantics.
- MCP accepts inline typed data only. It never resolves Agent-controlled file
  paths against ambient process state.
- The complete serialized result must respect the selected response limit.
  Requests, node counts, relation counts, query counts, and wall time are
  cumulatively bounded.
- A receipt identifies a calculation and its hashes. It is never called proof
  and never asserts that declared business relations are true.

## Review sequences

Rerun `npm run check`, then exercise a built CLI request, built MCP stdio call,
built HTTP call, and the browser workflow. Negative review must include unknown
nodes, duplicate relations, cycles, shuffled input order, oversized requests,
response overflow, misspelled fields, and post-error recovery.

Report development regression, runtime Agent flow, runtime human flow, and
owner business/experience acceptance separately. Do not commit, publish,
deploy, or expand product scope unless the owner explicitly asks.
