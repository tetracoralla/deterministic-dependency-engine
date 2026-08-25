# Review contract

Review the current executable source and transports. Prior screenshots, hashes,
or green reports are not acceptance authority.

## Development regression

- strict request and output models reject unknown fields;
- relation endpoints exist, node ids and relations are unique;
- cycle SCCs and witnesses contain real declared edges;
- shuffled node and relation arrays produce byte-identical canonical results;
- topological layers respect every prerequisite relation;
- a satisfied target or intermediate node terminates current-work traversal
  without changing the target's complete structural `required` closure;
- resolve, impact, slice, and explain agree on direction;
- maximum-depth acyclic input does not depend on the JavaScript call stack;
- whole-call deadlines include validation, hashing, and serialization;
- request limits and complete response limits cover successes, structural
  errors, streamed bodies without `Content-Length`, CLI formatting, and MCP
  content plus structured content; CLI framing bytes do not consume the
  budget and MCP degrades to structured-only delivery before failing;
- blocker-path explanation counts response bytes while reconstructing paths and
  rejects before amplified paths are materialized, instead of failing only
  after the whole result is built; equal-length path ties preserve root-forward
  code-point order and blocker paths never cross satisfied branches, pinned by tests;
- large requests run on isolated, killable compute children with a bounded
  queue: queue overflow and shutdown return a stable `SERVER_BUSY` (never a
  mislabeled `TIMEOUT`), a reply with a mismatched id cannot disarm the
  watchdog, malformed or operation-mismatched replies are rejected, a crashed
  child reports bounded exit details and is replaced, queued work keeps its
  original deadline, a child that stops checking the deadline is destroyed
  within that deadline, compute children have a bounded old-space heap, closing
  the pool always settles even on an empty event loop, and inline small calls
  stay independent of busy children;
- the MCP stdio transport bounds its read buffer near the request ceiling, so
  a runaway inbound message closes the connection promptly for the host to
  restart instead of buffering, parsing, and multiplying it in memory;
- the browser graph source is UTF-8 byte-bounded before JSON parsing, while the
  complete operation request remains subject to the shared core limit;
- a stalled or trickling HTTP body cannot hold a server connection open far
  beyond the engine's wall-clock limit;
- one failed call does not contaminate a later valid call;
- public MCP names, annotations, plugin manifest, and Skill stay aligned.

## Runtime Agent flow

Use a fresh MCP stdio process. Inspect `tools/list`, then call each public tool.
The dominant resolve prompt must be constructible from its own live schema and
must not require list/search/describe. Exercise valid, cycle, unknown-field,
oversized, and response-overflow cases.
The explain tool must publish its blocked and impact branches in its live
schema. Misspelled fields and wrong-branch fields must return the same
structured `INVALID_REQUEST` result shape as other core calls.

## Runtime human flow

Open the built UI (the example graph loads on open), change satisfied facts,
switch operations, run a valid request, copy JSON, cause an invalid JSON/graph
error, recover, and verify stale results are not presented as current. Check
desktop and mobile.
Validation must expose structural issue codes and messages rather than only a
valid/invalid summary. Syntactically valid but structurally malformed graph
JSON must reach core validation without crashing the UI.

Verify the transparent Sphere is the default, dominant surface and does not
paint a solid globe behind the declared graph. Analysis controls and results
must be absent until Analysis is opened; opening and closing the overlay must
preserve the full spatial viewport. Drag and keyboard rotation,
wheel/button/keyboard zoom, node focus, Escape cancellation, and Reset must
preserve the source and query. A
cycle must remain inspectable with an explicit fallback warning; invalid JSON
must show a recoverable state; dense input must suppress overview links rather
than attempting to paint every relation. Switch Sphere to Source and back to
exercise canvas observer, pointer capture, and animation-frame cleanup. Check
the flow at desktop and mobile widths and inspect the current browser console.
Product, view, analysis, focus, and zoom controls must remain bounded floating
surfaces rather than full-width bars. Opening the floating Analysis panel must
leave the canvas dimensions unchanged, with an explicit close action available
when the originating Analysis control is obscured.

## Business and experience

Owner acceptance remains separate. The human surface should expose declared
graph, query facts, operation, action, and actionable result—not MCP, schema
catalogs, receipts, model reasoning, implementation metadata, or category
marketing. The sphere is a read-only spatial inspection surface, not a claim
that the engine inferred a spatial truth or a replacement for exact structured
results.
