import { Fragment, memo, useMemo, useState } from "react";
import type { ReactNode } from "react";

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
}

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/gu;

/** Beyond this many lines, token spans cost more than they are worth; render plain text. */
const HIGHLIGHT_MAX_LINES = 4_000;

const HighlightedLine = memo(function HighlightedLine({ line }: { line: string }) {
  const children: ReactNode[] = [];
  let cursor = 0;
  for (const match of line.matchAll(JSON_TOKEN)) {
    const index = match.index;
    if (index > cursor) children.push(line.slice(cursor, index));
    const kind = match[1] !== undefined ? "json-key" : match[2] !== undefined ? "json-string" : "json-literal";
    children.push(<span className={kind} key={index}>{match[0]}</span>);
    cursor = index + match[0].length;
  }
  if (cursor < line.length) children.push(line.slice(cursor));
  return <>{children}</>;
});

export const CodeEditor = memo(function CodeEditor({ value, onChange }: CodeEditorProps) {
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const sourceLines = useMemo(() => value.split("\n"), [value]);
  const lineNumbers = useMemo(
    () => Array.from({ length: sourceLines.length }, (_, index) => index + 1).join("\n"),
    [sourceLines.length],
  );
  const highlighted = useMemo(() => {
    if (sourceLines.length > HIGHLIGHT_MAX_LINES) return value;
    return sourceLines.map((line, lineIndex) => (
      <Fragment key={lineIndex}>
        <HighlightedLine line={line} />
        {lineIndex < sourceLines.length - 1 ? "\n" : null}
      </Fragment>
    ));
  }, [sourceLines, value]);

  return (
    <div className="code-editor">
      <pre className="line-numbers" aria-hidden="true" style={{ transform: `translateY(${-scrollTop}px)` }}>
        {lineNumbers}
      </pre>
      <div className="code-input-wrap">
        <pre aria-hidden="true" style={{ transform: `translate(${-scrollLeft}px, ${-scrollTop}px)` }}>{highlighted}</pre>
        <textarea
          aria-label="Dependency graph JSON"
          spellCheck={false}
          wrap="off"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onScroll={(event) => {
            setScrollTop(event.currentTarget.scrollTop);
            setScrollLeft(event.currentTarget.scrollLeft);
          }}
        />
      </div>
    </div>
  );
});
