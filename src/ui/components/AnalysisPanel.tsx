import { useEffect, useRef, type KeyboardEvent } from "react";
import type { EngineResult, Operation } from "../../core/contracts.js";
import { OperationTabs } from "./OperationTabs.js";
import { QueryFields, type QueryState } from "./QueryFields.js";
import { ResultView } from "./ResultView.js";

type CopyState = "idle" | "copied" | "failed";

interface AnalysisPanelProps {
  modal: boolean;
  operation: Operation;
  query: QueryState;
  result: EngineResult;
  labels: ReadonlyMap<string, string>;
  stale: boolean;
  copyState: CopyState;
  runLabel: string;
  onOperationChange: (operation: Operation) => void;
  onQueryChange: (query: QueryState) => void;
  onRun: () => void;
  onCopy: () => void;
  onClose: () => void;
}

const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

export function AnalysisPanel({
  modal,
  operation,
  query,
  result,
  labels,
  stale,
  copyState,
  runLabel,
  onOperationChange,
  onQueryChange,
  onRun,
  onCopy,
  onClose,
}: AnalysisPanelProps) {
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!modal) return;
    const activeOperation = panelRef.current?.querySelector<HTMLElement>(".operation-tabs button[aria-pressed=\"true\"]");
    activeOperation?.focus();
  }, [modal]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (!modal || event.key !== "Tab") return;
    const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      .filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <aside
      ref={panelRef}
      id="analysis-panel"
      className="analysis-panel"
      aria-label="Analysis"
      aria-modal={modal || undefined}
      role={modal ? "dialog" : undefined}
      onKeyDown={handleKeyDown}
    >
      <header className="analysis-mobile-header">
        <strong>Analysis</strong>
        <button type="button" aria-label="Close analysis" onClick={onClose}>×</button>
      </header>
      <div className="analysis-controls">
        <OperationTabs value={operation} onChange={onOperationChange} />
        <QueryFields operation={operation} state={query} onChange={onQueryChange} />
        <button className="primary-action" type="button" aria-label={`Run: ${runLabel}`} onClick={onRun}>Run</button>
      </div>
      <ResultView
        result={result}
        labels={labels}
        stale={stale}
        onCopy={onCopy}
        copyState={copyState}
      />
    </aside>
  );
}
