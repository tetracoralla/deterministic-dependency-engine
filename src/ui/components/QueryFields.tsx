import type { Operation } from "../../core/contracts.js";

export interface QueryState {
  targets: string;
  satisfied: string;
  changed: string;
  focus: string;
  direction: "prerequisites" | "dependents" | "both";
  explanationKind: "blocked" | "impact";
  affected: string;
}

interface QueryFieldsProps {
  operation: Operation;
  state: QueryState;
  onChange: (next: QueryState) => void;
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="query-field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export function QueryFields({ operation, state, onChange }: QueryFieldsProps) {
  const update = <K extends keyof QueryState>(key: K, value: QueryState[K]) => onChange({ ...state, [key]: value });
  if (operation === "validate") return null;
  if (operation === "resolve") {
    return (
      <div className="query-row two-columns">
        <TextField label="Targets" value={state.targets} onChange={(value) => update("targets", value)} />
        <TextField label="Satisfied" value={state.satisfied} onChange={(value) => update("satisfied", value)} />
      </div>
    );
  }
  if (operation === "impact") {
    return (
      <div className="query-row">
        <TextField label="Changed" value={state.changed} onChange={(value) => update("changed", value)} />
      </div>
    );
  }
  if (operation === "slice") {
    return (
      <div className="query-row two-columns">
        <TextField label="Focus" value={state.focus} onChange={(value) => update("focus", value)} />
        <label className="query-field">
          <span>Direction</span>
          <select value={state.direction} onChange={(event) => update("direction", event.target.value as QueryState["direction"])}>
            <option value="prerequisites">Prerequisites</option>
            <option value="dependents">Dependents</option>
            <option value="both">Both</option>
          </select>
        </label>
      </div>
    );
  }
  return (
    <div className="query-row explain-row">
      <label className="query-field mode-field">
        <span>Explain</span>
        <select value={state.explanationKind} onChange={(event) => update("explanationKind", event.target.value as QueryState["explanationKind"])}>
          <option value="blocked">Blocked target</option>
          <option value="impact">Impact path</option>
        </select>
      </label>
      {state.explanationKind === "blocked" ? (
        <>
          <TextField label="Target" value={state.targets} onChange={(value) => update("targets", value)} />
          <TextField label="Satisfied" value={state.satisfied} onChange={(value) => update("satisfied", value)} />
        </>
      ) : (
        <>
          <TextField label="Changed" value={state.changed} onChange={(value) => update("changed", value)} />
          <TextField label="Affected" value={state.affected} onChange={(value) => update("affected", value)} />
        </>
      )}
    </div>
  );
}
