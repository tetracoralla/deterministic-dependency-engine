---
name: reason-about-dependencies
description: Resolve prerequisites, ready work, execution order, blockers, change impact, dependency slices, and path explanations with Deterministic Dependency Engine over an explicitly declared graph. Use when a task asks who depends on what or why work is blocked; do not use it to infer undeclared relations or solve version/provider alternatives.
---

# Reason about declared dependencies with Deterministic Dependency Engine

Call the matching direct tool once. Supply the graph with explicit
`dependent` and `prerequisite` fields; never translate it to `from` / `to`.

- Use `dependency_resolve` for what remains, what is ready, and execution order.
- Use `dependency_impact` for downstream effects of changed nodes.
- Use `dependency_explain` for blocker paths or one impact path.
- Use `dependency_slice` when only the minimal relevant graph is needed.
- Use `graph_validate` when legality, cycles, or ordering is the question.

Treat `satisfied` and `changed` as query-local facts, not graph properties. A
cycle or invalid graph is a result to repair, not permission to guess an order.
Present the actionable structured result compactly. A calculation receipt only
identifies the computation; never describe it as proof that the declared
relations are true.
