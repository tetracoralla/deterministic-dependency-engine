# Gridlace product model

## Purpose

Gridlace is a deterministic reasoning kernel for declared dependency
graphs. A developer or Agent supplies graph structure, separate current facts,
and a query. The engine computes legality, prerequisite closure, execution
layers, blockers, impact, minimal relevant subgraphs, and path explanations.

It replaces repeated model reasoning about transitive dependency relations. It
does not discover dependencies, judge whether a declaration is true, execute
tasks, arbitrate state, or solve alternatives and version constraints.

> The engine proves derivations over declared relations, not the truth of the
> relations themselves.

## Users and routes

- Human user: a developer or trained operator pastes a graph, chooses one
  operation, changes its query facts, runs it, and copies the structured result.
- Agent user: an Agent calls one of five direct tools without discovery, then
  consumes the structured result as final calculation output.
- Dominant route budget: one semantic match and one domain-tool call. Invalid
  input returns one stable error without speculative retries.

## Shared model

- `graph`: stable declared nodes and `dependent` / `prerequisite` relations.
- `context`: query-local facts such as `satisfied` or `changed` nodes.
- `query`: targets, focus nodes, direction, or explanation endpoints.

All public lists are canonicalized by code-point ordering. The graph schema is
`agent-deps/v1`. Node ids are opaque, case-sensitive strings.

## Operations

1. `graph_validate`: structural and graph diagnostics, strongly connected
   components, cycle witnesses, and topological order/layers when acyclic.
2. `dependency_resolve`: required closure, remaining work, ready work,
   execution layers, direct blockers, and root blockers for target nodes.
3. `dependency_impact`: direct and transitive dependents of changed nodes,
   grouped into propagation layers.
4. `dependency_slice`: the canonical minimal graph around focus nodes in the
   `prerequisites`, `dependents`, or `both` direction.
5. `dependency_explain`: either root-blocker paths for a target or one shortest
   deterministic impact path between two nodes.

Cycles are valid diagnostic input for `graph_validate`. Operations that require
a partial order return `DEPENDENCY_CYCLE` with repairable witnesses.

`required` describes the complete declared prerequisite closure of the target.
For current planning, a node listed in `satisfied` is a completed subtree: it
and its prerequisites are not returned as remaining work or blockers. This
keeps structural meaning separate from current completion facts.

## V1 boundary

V1 supports conjunctive `A requires B` relations only. Alternatives, conflicts,
provider selection, version ranges, SAT/SMT, PubGrub, workflow execution,
automatic repository scanning, graph persistence, and visual graph editing are
future products or adapters, not hidden V1 features.

## Surfaces

The TypeScript core owns schemas, normalization, algorithms, receipts, errors,
and bounds. Library, CLI, MCP stdio, HTTP Worker/server, and React UI are thin
adapters. MCP and HTTP accept inline JSON only. The CLI may deliberately read a
human-provided file path.

## Limits and truth

One logical call has cumulative request bytes, node, relation, query item,
deadline, and complete response-byte limits. The deadline starts at adapter
call entry and covers input parsing, schema validation, graph work, receipt
hashing, result validation, and serialization. The selected response limit
bounds the serialized result in every carrier, including CLI formatting and
MCP content plus structured content. Carrier framing (the CLI trailing
newline) does not consume the budget; MCP drops its redundant text rendering
before failing when only the complete envelope overflows. Blocker-path
explanations count response bytes while reconstructing paths, so amplified
output is rejected before it is built; when several equal-length shortest
paths exist for one root blocker, the selected path preserves root-forward
code-point ordering and never crosses a satisfied branch. The browser adapter
rejects graph source above the hard request ceiling before JSON parsing; the
core still measures the complete operation request after parsing. An over-limit
graph source therefore cannot be multiplied by the parser, while an operation
whose wrapper or query crosses the limit is still rejected by the shared core.
The MCP stdio transport bounds its read buffer near the request ceiling; an
over-limit message closes the connection promptly and the host restarts the
server. Adapter requests
above the inline size run in isolated, killable compute children behind a
bounded queue: queue overflow and shutdown return a stable `SERVER_BUSY`, a
crashed child reports bounded exit details and is replaced, invalid child
responses are rejected at the parent boundary, queued work retains the
original logical deadline, and a child that stops checking the deadline is
destroyed within that deadline. Compute children also carry a bounded old-space
heap and are replaced after failure. Algorithms are bounded
linear or linearithmic graph traversals over those inputs. Receipt hashes
identify the canonical graph, request, and result calculation. They do not
validate the source or business truth of declared edges.
