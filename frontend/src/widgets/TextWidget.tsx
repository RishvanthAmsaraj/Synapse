/**
 * TextWidget — Renders markdown text blocks on the canvas.
 *
 * Uses CSS variables for theming instead of hardcoded colors.
 * This ensures text is readable in both dark and light modes.
 */

import { useEffect, useRef, useState } from 'react';
import './TextWidget.css';

export type TextWidgetData = {
  content: string;
  /** Panel slug, so an edit can be attributed back to the right panel. */
  panel?: string;
  /** Optional heading. With several text panels open, this is how the user
   *  tells them apart at a glance. */
  title?: string;
};

// ---------------------------------------------------------------------------
// Minimal markdown → React renderer
// Handles: ## headings, **bold**, *italic*, `code`, - lists (nested), blank lines
// No external dependencies.
// ---------------------------------------------------------------------------
function renderMarkdown(raw: string): React.ReactNode[] {
  const lines = raw.split('\n');
  const nodes: React.ReactNode[] = [];
  let key = 0;

  function renderInline(text: string): React.ReactNode[] {
    const parts: React.ReactNode[] = [];
    const re = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)/g;
    let last = 0, m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parts.push(text.slice(last, m.index));
      if (m[1]) parts.push(<strong key={key++} className="textwidget-bold">{m[2]}</strong>);
      else if (m[3]) parts.push(<em key={key++} className="textwidget-italic">{m[4]}</em>);
      else if (m[5]) parts.push(<code key={key++} className="textwidget-code">{m[6]}</code>);
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    if (trimmed === '') {
      i++;
      continue;
    }

    const h3 = trimmed.match(/^###\s+(.*)/);
    const h2 = trimmed.match(/^##\s+(.*)/);
    const h1 = trimmed.match(/^#\s+(.*)/);
    if (h1) { nodes.push(<h1 key={key++} className="textwidget-h1">{renderInline(h1[1])}</h1>); i++; continue; }
    if (h2) { nodes.push(<h2 key={key++} className="textwidget-h2">{renderInline(h2[1])}</h2>); i++; continue; }
    if (h3) { nodes.push(<h3 key={key++} className="textwidget-h3">{renderInline(h3[1])}</h3>); i++; continue; }

    if (/^\s*[-*]\s/.test(trimmed)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*[-*]\s/.test(lines[i].trimEnd())) {
        const itemLine = lines[i];
        const text = itemLine.replace(/^\s*[-*]\s/, '');
        items.push(
          <li key={key++} className="textwidget-li">{renderInline(text)}</li>
        );
        i++;
      }
      nodes.push(<ul key={key++} className="textwidget-ul">{items}</ul>);
      continue;
    }

    if (/^\d+\.\s/.test(trimmed)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trimEnd())) {
        const text = lines[i].replace(/^\d+\.\s/, '');
        items.push(<li key={key++} className="textwidget-li">{renderInline(text)}</li>);
        i++;
      }
      nodes.push(<ol key={key++} className="textwidget-ol">{items}</ol>);
      continue;
    }

    nodes.push(<p key={key++} className="textwidget-p">{renderInline(trimmed)}</p>);
    i++;
  }

  return nodes;
}

/**
 * TextWidget — and the first panel the user can write back into.
 *
 * Until now the canvas was one-directional: the agent could show you things,
 * and you could only look at them. Double-clicking a text panel opens the raw
 * markdown for editing, and committing it announces the change so the agent
 * learns what you changed. That is the return channel — the difference
 * between a display and a workspace two parties share.
 *
 * The edit is broadcast as a DOM event rather than a prop callback so widgets
 * stay renderable from the registry without threading handlers through it.
 */
export function TextWidget({ data }: { data: TextWidgetData }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.content);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Agent updates win while you are not editing; they never overwrite a draft
  // out from under you mid-edit.
  useEffect(() => { if (!editing) setDraft(data.content); }, [data.content, editing]);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  function commit() {
    setEditing(false);
    if (draft === data.content) return;
    // This event does two things: it writes the edit back into the panel so
    // the change is actually kept, and it tells the agent what changed.
    // Previously it only did the second, so an edit was announced and then
    // immediately overwritten by the agent's original text on the next
    // render — which looked exactly like "there is no way to save".
    window.dispatchEvent(new CustomEvent('synapse:panel-edit', {
      detail: { panel: data.panel ?? 'main', content: draft },
    }));
  }

  function cancel() {
    setDraft(data.content);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="textwidget-container editing">
        {data.title ? <h3 className="textwidget-title">{data.title}</h3> : null}
        <textarea
          ref={ref}
          className="textwidget-edit"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
            // Enter saves; Shift+Enter is a newline. Markdown needs multi-line
            // editing, so the modifier goes on the line break rather than on
            // the save — saving is the thing you do far more often.
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
          }}
        />
        <div className="textwidget-actions">
          <span className="textwidget-hint">Enter to save · Shift+Enter for a new line</span>
          <button type="button" className="tw-btn" onClick={cancel}>Cancel</button>
          <button type="button" className="tw-btn tw-btn-primary" onClick={commit}>Save</button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="textwidget-container"
      onDoubleClick={() => setEditing(true)}
      title="Double-click to edit"
    >
      {data.title ? <h3 className="textwidget-title">{data.title}</h3> : null}
      {renderMarkdown(data.content)}
    </div>
  );
}
