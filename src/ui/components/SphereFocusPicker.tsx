import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { compareIds } from "../../core/canonical.js";
import type { SphereNode } from "../sphere-layout.js";

export const MAX_FOCUS_OPTIONS = 24;

export interface FocusSearchResult {
  matches: SphereNode[];
  total: number;
}

function matchRank(node: SphereNode, normalizedQuery: string): number | null {
  const id = node.id.toLowerCase();
  const label = node.label.toLowerCase();
  if (id === normalizedQuery) return 0;
  if (label === normalizedQuery) return 1;
  if (id.startsWith(normalizedQuery)) return 2;
  if (label.startsWith(normalizedQuery)) return 3;
  if (id.includes(normalizedQuery)) return 4;
  if (label.includes(normalizedQuery)) return 5;
  return null;
}

export function searchFocusNodes(
  nodes: readonly SphereNode[],
  query: string,
  limit = MAX_FOCUS_OPTIONS - 1,
): FocusSearchResult {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery === "") return { matches: nodes.slice(0, limit), total: nodes.length };

  const ranked = nodes.flatMap((node) => {
    const rank = matchRank(node, normalizedQuery);
    return rank === null ? [] : [{ node, rank }];
  }).sort((left, right) => left.rank - right.rank || compareIds(left.node.id, right.node.id));

  return {
    matches: ranked.slice(0, limit).map(({ node }) => node),
    total: ranked.length,
  };
}

interface SphereFocusPickerProps {
  nodes: readonly SphereNode[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function SphereFocusPicker({ nodes, selectedId, onSelect }: SphereFocusPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const selectedNode = useMemo(
    () => selectedId === null ? null : nodes.find((node) => node.id === selectedId) ?? null,
    [nodes, selectedId],
  );
  const result = useMemo(() => searchFocusNodes(nodes, query), [nodes, query]);
  const options = useMemo(() => [null, ...result.matches.map((node) => node.id)] as Array<string | null>, [result.matches]);

  useEffect(() => {
    setQuery(selectedNode?.label ?? "");
  }, [selectedNode]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, options.length - 1)));
  }, [options.length]);

  const optionId = (index: number) => `${listboxId}-option-${index}`;
  const choose = (id: string | null) => {
    onSelect(id);
    setOpen(false);
    const node = id === null ? null : nodes.find((candidate) => candidate.id === id) ?? null;
    setQuery(node?.label ?? "");
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + direction + options.length) % options.length);
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      choose(options[activeIndex] ?? null);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setQuery(selectedNode?.label ?? "");
      setOpen(false);
    }
  };

  return (
    <label className="sphere-focus">
      <span>Focus</span>
      <div
        ref={rootRef}
        className="sphere-focus-picker"
        onBlur={(event) => {
          if (!rootRef.current?.contains(event.relatedTarget as Node | null)) {
            setQuery(selectedNode?.label ?? "");
            setOpen(false);
          }
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Overview"
          role="combobox"
          aria-label="Focus node"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={open ? optionId(activeIndex) : undefined}
          onFocus={(event) => {
            setOpen(true);
            const selectedIndex = selectedId === null ? 0 : options.indexOf(selectedId);
            setActiveIndex(selectedIndex < 0 ? 0 : selectedIndex);
            event.currentTarget.select();
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
        />
        {open && (
          <div className="sphere-focus-menu">
            <div id={listboxId} className="sphere-focus-options" role="listbox" aria-label="Focus node results">
              <button
                id={optionId(0)}
                type="button"
                tabIndex={-1}
                role="option"
                aria-selected={selectedId === null}
                className={activeIndex === 0 ? "active" : ""}
                onPointerDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(0)}
                onClick={() => choose(null)}
              >Overview</button>
              {result.matches.map((node, index) => {
                const optionIndex = index + 1;
                return (
                  <button
                    id={optionId(optionIndex)}
                    key={node.id}
                    type="button"
                    tabIndex={-1}
                    role="option"
                    aria-selected={node.id === selectedId}
                    className={activeIndex === optionIndex ? "active" : ""}
                    onPointerDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveIndex(optionIndex)}
                    onClick={() => choose(node.id)}
                  >
                    <strong>{node.label}</strong>
                    {node.label !== node.id && <code>{node.id}</code>}
                  </button>
                );
              })}
            </div>
            {result.total > result.matches.length && (
              <span className="sphere-focus-more" role="status">
                {result.total.toLocaleString()} matches · refine search
              </span>
            )}
          </div>
        )}
      </div>
    </label>
  );
}
