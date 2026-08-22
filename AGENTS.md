# Gridlace repository contract

This repository owns Gridlace, a deterministic dependency-reasoning
product. Product identity lives in `docs/PRODUCT_IDENTITY.md`; product meaning
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
