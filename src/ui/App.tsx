import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { byteLength } from "../core/canonical.js";
import { HARD_LIMITS, PRODUCT_NAME, type DependencyGraph, type EngineResult, type Operation } from "../core/contracts.js";
import { prepareGraphProjection, runOperation } from "../core/engine.js";
import { CodeEditor } from "./components/CodeEditor.js";
import { AnalysisPanel } from "./components/AnalysisPanel.js";
import type { QueryState } from "./components/QueryFields.js";
import { EXAMPLE_GRAPH, EXAMPLE_SOURCE } from "./example.js";
import { safeGraphNodes } from "./graph-data.js";
import { useMediaQuery } from "./use-media-query.js";

const GraphSphere = lazy(async () => {
  const module = await import("./components/GraphSphere.js");
  return { default: module.GraphSphere };
});

const INITIAL_QUERY: QueryState = {
  targets: "release",
  satisfied: "schema, backend",
  changed: "schema",
  focus: "release",
  direction: "prerequisites",
  explanationKind: "blocked",
  affected: "release",
};

const INITIAL_OPERATION: Operation = "resolve";

/** Identifies the inputs of one completed run without serializing the whole graph source. */
interface RunSignature {
  source: string;
  operation: Operation;
  query: QueryState;
}

interface CompletedRun {
  result: EngineResult;
  labels: ReadonlyMap<string, string>;
  signature: RunSignature;
}

function labelsOf(graph: unknown): ReadonlyMap<string, string> {
  return new Map(
    safeGraphNodes(graph).flatMap((node) => node.label === undefined ? [] : [[node.id, node.label] as const]),
  );
}

function exampleRun(): CompletedRun {
  return {
    result: runOperation("resolve", {
      graph: EXAMPLE_GRAPH,
      targets: ["release"],
      satisfied: ["schema", "backend"],
    }),
    labels: labelsOf(EXAMPLE_GRAPH),
    signature: { source: EXAMPLE_SOURCE, operation: INITIAL_OPERATION, query: INITIAL_QUERY },
  };
}

export function queryEquals(left: QueryState, right: QueryState): boolean {
  return left.targets === right.targets
    && left.satisfied === right.satisfied
    && left.changed === right.changed
    && left.focus === right.focus
    && left.direction === right.direction
    && left.explanationKind === right.explanationKind
    && left.affected === right.affected;
}

function signatureEquals(left: RunSignature, source: string, operation: Operation, query: QueryState): boolean {
  return left.source === source && left.operation === operation && queryEquals(left.query, query);
}

export function parseNodeIds(value: string, graph: unknown): string[] {
  const exact = value.trim();
  if (exact !== "" && safeGraphNodes(graph).some((node) => node.id === exact)) return [exact];
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function actionLabel(operation: Operation): string {
  return {
    validate: "Validate graph",
    resolve: "Resolve dependencies",
    impact: "Analyze impact",
    slice: "Create dependency slice",
    explain: "Explain dependency",
  }[operation];
}

function makeRequest(operation: Operation, graph: DependencyGraph, query: QueryState): unknown {
  if (operation === "validate") return { graph };
  if (operation === "resolve") return { graph, targets: parseNodeIds(query.targets, graph), satisfied: parseNodeIds(query.satisfied, graph) };
  if (operation === "impact") return { graph, changed: parseNodeIds(query.changed, graph) };
  if (operation === "slice") return { graph, focus: parseNodeIds(query.focus, graph), direction: query.direction };
  if (query.explanationKind === "blocked") {
    return { graph, kind: "blocked", target: parseNodeIds(query.targets, graph)[0] ?? "", satisfied: parseNodeIds(query.satisfied, graph) };
  }
  return {
    graph,
    kind: "impact",
    changed: parseNodeIds(query.changed, graph)[0] ?? "",
    affected: parseNodeIds(query.affected, graph)[0] ?? "",
  };
}

export type GraphSourceParseResult =
  | { status: "ok"; graph: DependencyGraph }
  | { status: "error"; code: "INVALID_JSON" }
  | { status: "error"; code: "REQUEST_TOO_LARGE"; actualBytes: number };

export function parseGraphSource(source: string): GraphSourceParseResult {
  const actualBytes = byteLength(source);
  if (actualBytes > HARD_LIMITS.maxRequestBytes) {
    return { status: "error", code: "REQUEST_TOO_LARGE", actualBytes };
  }
  try {
    return { status: "ok", graph: JSON.parse(source) as DependencyGraph };
  } catch {
    return { status: "error", code: "INVALID_JSON" };
  }
}

type CopyState = "idle" | "copied" | "failed";
type GraphView = "source" | "sphere";

export function App() {
  const [source, setSource] = useState(EXAMPLE_SOURCE);
  const [operation, setOperation] = useState<Operation>(INITIAL_OPERATION);
  const [query, setQuery] = useState(INITIAL_QUERY);
  const [completedRun, setCompletedRun] = useState<CompletedRun>(exampleRun);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [graphView, setGraphView] = useState<GraphView>("sphere");
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);
  const analysisTriggerRef = useRef<HTMLButtonElement>(null);
  const compactAnalysis = useMediaQuery("(max-width: 900px)");
  const resultIsStale = !signatureEquals(completedRun.signature, source, operation, query);

  // Counts follow the source with a small deferral so typing stays responsive on
  // large graphs; the run action itself always parses the current source.
  const deferredSource = useDeferredValue(source);
  const countsSource = useMemo(() => parseGraphSource(deferredSource), [deferredSource]);
  // Unlike the decorative counts, the spatial view must never open on a
  // deferred copy immediately after an edit.
  const currentSphereSource = useMemo(
    () => graphView === "sphere" ? parseGraphSource(source) : null,
    [graphView, source],
  );
  const sphereState = useMemo(() => {
    if (graphView !== "sphere") return null;
    if (currentSphereSource === null) return null;
    if (currentSphereSource.status === "error") {
      return {
        graph: null,
        executionLayers: null,
        issueCount: 0,
        error: currentSphereSource.code === "REQUEST_TOO_LARGE"
          ? "The dependency graph exceeds the input limit."
          : "Fix the JSON syntax to open the sphere.",
      };
    }
    const validation = prepareGraphProjection({ graph: currentSphereSource.graph });
    if (validation.status === "error") {
      return { graph: null, executionLayers: null, issueCount: 0, error: validation.error.message };
    }
    return {
      graph: validation.graph,
      executionLayers: validation.executionLayers,
      issueCount: validation.issues.length,
      error: null,
    };
  }, [currentSphereSource, graphView]);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const run = useCallback(() => {
    setCopyState("idle");
    // Parse the immediate source so a run right after typing can never compute
    // against a deferred, stale copy of the graph.
    const parsedSource = parseGraphSource(source);
    const signature: RunSignature = { source, operation, query };
    if (parsedSource.status === "error") {
      const error = parsedSource.code === "REQUEST_TOO_LARGE"
        ? {
            code: parsedSource.code,
            message: `The dependency graph source requires ${parsedSource.actualBytes} bytes, above the ${HARD_LIMITS.maxRequestBytes}-byte limit.`,
            details: { actual_bytes: parsedSource.actualBytes, max_request_bytes: HARD_LIMITS.maxRequestBytes },
          }
        : { code: parsedSource.code, message: "The dependency graph is not valid JSON." };
      setCompletedRun({
        result: { status: "error", error },
        labels: new Map(),
        signature,
      });
      return;
    }
    const { graph } = parsedSource;
    setCompletedRun({
      result: runOperation(operation, makeRequest(operation, graph, query)),
      labels: labelsOf(graph),
      signature,
    });
  }, [operation, query, source]);

  const copy = async () => {
    window.clearTimeout(copyTimer.current);
    try {
      await navigator.clipboard.writeText(JSON.stringify(completedRun.result, null, 2));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    copyTimer.current = window.setTimeout(() => setCopyState("idle"), 1_500);
  };

  const closeAnalysis = useCallback(() => {
    setAnalysisOpen(false);
    window.requestAnimationFrame(() => analysisTriggerRef.current?.focus());
  }, []);

  const countsGraph = countsSource.status === "ok" ? countsSource.graph : null;
  const countsGraphShaped = countsGraph !== null && Array.isArray(countsGraph.nodes) && Array.isArray(countsGraph.requires);
  const counts = countsGraphShaped
    ? `${countsGraph.nodes.length} nodes · ${countsGraph.requires.length} relations`
    : countsSource.status === "error"
      ? countsSource.code === "REQUEST_TOO_LARGE" ? "Input too large" : "Invalid JSON"
      : "Invalid graph";
  const countsInvalid = !countsGraphShaped;

  return (
    <div className="app" onKeyDown={(event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        setAnalysisOpen(true);
        run();
      }
    }}>
      <header className="topbar">
        <h1>{PRODUCT_NAME}</h1>
      </header>
      <main className={analysisOpen ? "workspace analysis-open" : "workspace"}>
        <section className="input-panel" inert={analysisOpen && compactAnalysis ? true : undefined}>
          <div className="editor-heading">
            <h2 className="visually-hidden">Dependency graph</h2>
            <div className="editor-heading-actions">
              <div className="graph-view-switch" role="group" aria-label="Dependency graph view">
                <button type="button" aria-pressed={graphView === "source"} onClick={() => setGraphView("source")}>Source</button>
                <button type="button" aria-pressed={graphView === "sphere"} onClick={() => setGraphView("sphere")}>Sphere</button>
              </div>
              <span className={countsInvalid ? "graph-summary invalid" : "graph-summary"}>{counts}</span>
              <button
                ref={analysisTriggerRef}
                className={analysisOpen ? "analysis-toggle active" : "analysis-toggle"}
                type="button"
                aria-expanded={analysisOpen}
                aria-controls="analysis-panel"
                onClick={() => setAnalysisOpen((open) => !open)}
              >Analysis</button>
            </div>
          </div>
          {graphView === "source" ? (
            <CodeEditor value={source} onChange={setSource} />
          ) : (
            <Suspense fallback={<div className="sphere-loading" role="status">Opening sphere…</div>}>
              <GraphSphere
                graph={sphereState?.graph ?? null}
                executionLayers={sphereState?.executionLayers ?? null}
                issueCount={sphereState?.issueCount ?? 0}
                error={sphereState?.error ?? "Preparing the dependency sphere."}
                motionEnabled={!analysisOpen}
              />
            </Suspense>
          )}
        </section>
        {analysisOpen && (
          <AnalysisPanel
            modal={compactAnalysis}
            operation={operation}
            query={query}
            result={completedRun.result}
            labels={completedRun.labels}
            stale={resultIsStale}
            copyState={copyState}
            runLabel={actionLabel(operation)}
            onOperationChange={(next) => {
              setOperation(next);
              setCopyState("idle");
            }}
            onQueryChange={setQuery}
            onRun={run}
            onCopy={() => void copy()}
            onClose={closeAnalysis}
          />
        )}
      </main>
    </div>
  );
}
