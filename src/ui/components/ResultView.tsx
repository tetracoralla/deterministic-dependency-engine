import { memo } from "react";
import type { EngineResult, ResolveResult } from "../../core/contracts.js";

interface ResultViewProps {
  result: EngineResult;
  labels: ReadonlyMap<string, string>;
  stale: boolean;
  onCopy: () => void;
  copyState: "idle" | "copied" | "failed";
}

function displayName(labels: ReadonlyMap<string, string>, id: string): string {
  return labels.get(id) ?? id;
}

function ResolvePlan({ result, labels }: { result: ResolveResult; labels: ReadonlyMap<string, string> }) {
  if (result.remaining.length === 0) {
    return <p className="result-summary">Nothing remaining.</p>;
  }
  return (
    <div className="plan-content">
      <section className="result-section">
        <h3>Execution order</h3>
        <ol className="execution-list">
          {result.execution_layers.map((layer, index) => (
            <li key={`${index}-${layer.join("-")}`}>
              <span className="step-number">{index === 0 ? "Now" : index + 1}</span>
              <span>{layer.map((node) => displayName(labels, node)).join(", ")}</span>
            </li>
          ))}
        </ol>
      </section>
      {result.blocked.length > 0 && (
        <section className="result-section blocked-section">
          <h3>Blocked</h3>
          <div className="blocked-list">
            {result.blocked.map((item) => (
              <div className="blocked-row" key={item.node}>
                <span>{displayName(labels, item.node)}</span>
                <span className="by">by</span>
                <span>{item.by.map((node) => displayName(labels, node)).join(", ")}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function GenericResult({ result, labels }: { result: Exclude<EngineResult, ResolveResult>; labels: ReadonlyMap<string, string> }) {
  if (result.status === "error") {
    return (
      <div className="error-result" role="alert">
        <p>{result.error.message}</p>
      </div>
    );
  }
  if (result.kind === "validation") {
    return (
      <div className="generic-result">
        <section><h3>{result.valid ? "Valid graph" : "Needs repair"}</h3></section>
        {result.issues.length > 0 && (
          <section>
            <h3>Issues</h3>
            <ul className="issue-list">
              {result.issues.map((issue, index) => (
                <li key={`${issue.code}-${issue.nodes.join("-")}-${index}`}>
                  <code>{issue.code}</code>
                  <span>{issue.message}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {result.cycles.length > 0 && (
          <section>
            <h3>Cycles</h3>
            {result.cycles.map((cycle, index) => <p className="relation" key={`${index}-${cycle.witness.join("-")}`}>{cycle.witness.map((node) => displayName(labels, node)).join(" → ")}</p>)}
          </section>
        )}
        {result.execution_layers !== null && <section><h3>Execution layers</h3><p>{result.execution_layers.map((layer) => layer.map((node) => displayName(labels, node)).join(", ")).join(" → ")}</p></section>}
      </div>
    );
  }
  if (result.kind === "impact") {
    return (
      <div className="generic-result">
        {result.transitive.length === 0
          ? <p className="result-summary">No affected nodes.</p>
          : <section>
            <h3>Propagation</h3>
            <p>{result.propagation_layers.map((layer) => layer.map((node) => displayName(labels, node)).join(", ")).join(" → ")}</p>
          </section>}
      </div>
    );
  }
  if (result.kind === "slice") {
    return (
      <div className="generic-result">
        <section><h3>Relevant nodes</h3><p>{result.graph.nodes.map((node) => displayName(labels, node.id)).join(", ")}</p></section>
        {result.graph.requires.length > 0 && <section><h3>Relations</h3>{result.graph.requires.map((edge) => <p className="relation" key={`${edge.dependent}-${edge.prerequisite}`}>{displayName(labels, edge.dependent)} requires {displayName(labels, edge.prerequisite)}</p>)}</section>}
      </div>
    );
  }
  if (result.kind === "blocked_explanation") {
    return (
      <div className="generic-result">
        <section><h3>{result.blocked ? "Root blockers" : "Ready"}</h3><p>{result.root_blockers.map((node) => displayName(labels, node)).join(", ") || displayName(labels, result.target)}</p></section>
        {result.paths.length > 0 && <section><h3>Paths</h3>{result.paths.map((path, index) => <p className="relation" key={`${index}-${path.join("-")}`}>{path.map((node) => displayName(labels, node)).join(" → ")}</p>)}</section>}
      </div>
    );
  }
  return (
    <div className="generic-result">
      <section><h3>{result.reachable ? "Impact path" : "No impact path"}</h3><p>{result.path?.map((node) => displayName(labels, node)).join(" → ") ?? `${displayName(labels, result.changed)} does not affect ${displayName(labels, result.affected)}`}</p></section>
    </div>
  );
}

export const ResultView = memo(function ResultView({ result, labels, stale, onCopy, copyState }: ResultViewProps) {
  const title = result.status === "ok" && result.kind === "resolution"
    ? result.targets.length === 1 ? `${displayName(labels, result.targets[0] ?? "Target")} plan` : "Dependency plan"
    : result.status === "ok" && result.kind === "impact" ? "Impact analysis"
      : result.status === "ok" && result.kind === "slice" ? "Dependency slice"
        : result.status === "ok" && result.kind === "validation" ? "Graph validation"
          : result.status === "ok" ? "Explanation" : result.error.code;
  const copyLabel = copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy JSON";
  if (stale) {
    return (
      <section className="result-panel stale-panel" aria-label="Result" aria-live="polite">
        <p className="stale-result" role="status">Run to update.</p>
      </section>
    );
  }
  return (
    <section className="result-panel" aria-label="Result" aria-live="polite">
      <header className={result.status === "error" ? "result-header error-header" : "result-header"}>
        <h2>{title}</h2>
        <button type="button" className="text-action accent" onClick={onCopy}>{copyLabel}</button>
      </header>
      {result.status === "ok" && result.kind === "resolution"
        ? <ResolvePlan result={result} labels={labels} />
        : <GenericResult result={result as Exclude<EngineResult, ResolveResult>} labels={labels} />}
    </section>
  );
});
