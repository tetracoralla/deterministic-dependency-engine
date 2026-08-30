# Contributing to Deterministic Dependency Engine

This repository implements a deterministic dependency-reasoning engine.
Contributions should preserve one semantic core across the library, CLI, MCP,
HTTP, and browser adapters rather than add a parallel execution path.

## Set up the checkout

Install Node.js 22.12 or newer, then run:

```sh
npm ci
npm run check
```

If a contract change is intentional, update the executable Zod model first and
regenerate the distributed schema files with `npm run schema:generate`. Review
the generated diff; do not hand-edit a schema to bypass the runtime contract.

## Submit a focused change

- Add the smallest negative regression for every repaired edge case.
- Preserve code-point ordering, bounded complete responses, and whole-call
  deadlines.
- Keep graph structure, satisfied facts, and the query separate.
- Keep public relations named `dependent` and `prerequisite`.
- Do not add task execution, graph discovery, provider selection, SAT/SMT, a
  graph database, or a visual graph editor without an approved product change.
- Do not include credentials, private datasets, generated coverage, or local
  state.

By submitting a contribution, you agree that it is licensed under the Apache
License 2.0 unless you clearly state otherwise in the contribution.
