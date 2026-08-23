# Deterministic Dependency Engine identity

## Display identity

- Product name: **Deterministic Dependency Engine**
- Description: **Dependency Reasoning Over Declared Graphs**
- Publisher and developer identity: **openAdam**.

The project deliberately uses a descriptive identity rather than a separate
product brand. The name describes the implemented category without implying
graph discovery, task execution, or a visual graph editor. The product model
defines the exact scope.

## Stable technical identifiers

The display-name change does not replace compatibility-sensitive coordinates.
Keep these identifiers stable unless a separate migration is authorized:

- repository: `tetracoralla/deterministic-dependency-engine`
- package: `@openadam/dependency-engine`
- commands: `dependency-engine`, `dependency-engine-mcp`,
  `dependency-engine-http`
- engine and receipt id: `dependency-engine`
- graph schema: `agent-deps/v1`
- plugin id: `graph-dependency-solver`
- MCP server key: `dependency_engine`
- MCP tools: `graph_validate`, `dependency_resolve`, `dependency_impact`,
  `dependency_slice`, and `dependency_explain`
- canonical schema identifiers under `https://openadam.dev/dependency-engine/`

The schema identifiers are stable identifiers, not a promise that those URLs
are a hosted schema registry. The distributable schema files live in the
repository's `schemas/` directory.
