import type { Operation } from "../../core/contracts.js";

const OPERATIONS: Array<{ id: Operation; label: string }> = [
  { id: "resolve", label: "Resolve" },
  { id: "impact", label: "Impact" },
  { id: "explain", label: "Explain" },
  { id: "slice", label: "Slice" },
  { id: "validate", label: "Validate" },
];

interface OperationTabsProps {
  value: Operation;
  onChange: (value: Operation) => void;
}

export function OperationTabs({ value, onChange }: OperationTabsProps) {
  return (
    <div className="operation-tabs" role="group" aria-label="Dependency operation">
      {OPERATIONS.map((operation) => (
        <button
          key={operation.id}
          type="button"
          aria-pressed={value === operation.id}
          className={value === operation.id ? "active" : ""}
          onClick={() => onChange(operation.id)}
        >
          {operation.label}
        </button>
      ))}
    </div>
  );
}
