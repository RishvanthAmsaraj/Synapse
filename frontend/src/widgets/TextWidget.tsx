/**
 * TextWidget — Renders markdown text blocks on the canvas.
 *
 * Uses CSS variables for theming instead of hardcoded colors.
 * This ensures text is readable in both dark and light modes.
 */

import './TextWidget.css';

export type TextWidgetData = {
  content: string;
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

export function TextWidget({ data }: { data: TextWidgetData }) {
  return (
    <div className="textwidget-container">
      {renderMarkdown(data.content)}
    </div>
  );
}
