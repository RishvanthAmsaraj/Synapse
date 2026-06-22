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

  // Inline: **bold**, *italic*, `code`
  function renderInline(text: string): React.ReactNode[] {
    const parts: React.ReactNode[] = [];
    const re = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)/g;
    let last = 0, m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parts.push(text.slice(last, m.index));
      if (m[1]) parts.push(<strong key={key++} style={{ color: '#ffc800', fontWeight: 700 }}>{m[2]}</strong>);
      else if (m[3]) parts.push(<em key={key++} style={{ color: '#b0c8ff', fontStyle: 'italic' }}>{m[4]}</em>);
      else if (m[5]) parts.push(<code key={key++} style={{ background: '#1e1e1e', color: '#ffc800', borderRadius: 3, padding: '1px 5px', fontSize: 12, fontFamily: 'monospace' }}>{m[6]}</code>);
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
      // blank line — skip (spacing handled by margins)
      i++;
      continue;
    }

    // Headings
    const h3 = trimmed.match(/^###\s+(.*)/);
    const h2 = trimmed.match(/^##\s+(.*)/);
    const h1 = trimmed.match(/^#\s+(.*)/);
    if (h1) { nodes.push(<h1 key={key++} style={{ fontSize: 20, fontWeight: 700, color: '#fff', margin: '0 0 10px' }}>{renderInline(h1[1])}</h1>); i++; continue; }
    if (h2) { nodes.push(<h2 key={key++} style={{ fontSize: 17, fontWeight: 700, color: '#f0f0f0', margin: '8px 0 6px' }}>{renderInline(h2[1])}</h2>); i++; continue; }
    if (h3) { nodes.push(<h3 key={key++} style={{ fontSize: 15, fontWeight: 700, color: '#e8e8e8', margin: '6px 0 4px' }}>{renderInline(h3[1])}</h3>); i++; continue; }

    // List items — collect a run of them into a <ul>
    if (/^\s*[-*]\s/.test(trimmed)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*[-*]\s/.test(lines[i].trimEnd())) {
        const itemLine = lines[i];
        const indent = itemLine.match(/^(\s*)/)?.[1].length ?? 0;
        const text = itemLine.replace(/^\s*[-*]\s/, '');
        items.push(
          <li key={key++} style={{ marginBottom: 2, paddingLeft: indent > 0 ? 12 : 0, color: '#e0e0e0', listStyleType: indent > 0 ? 'circle' : 'disc' }}>
            {renderInline(text)}
          </li>
        );
        i++;
      }
      nodes.push(<ul key={key++} style={{ margin: '4px 0 6px', paddingLeft: 18 }}>{items}</ul>);
      continue;
    }

    // Ordered list items
    if (/^\d+\.\s/.test(trimmed)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trimEnd())) {
        const text = lines[i].replace(/^\d+\.\s/, '');
        items.push(<li key={key++} style={{ marginBottom: 2, color: '#e0e0e0' }}>{renderInline(text)}</li>);
        i++;
      }
      nodes.push(<ol key={key++} style={{ margin: '4px 0 6px', paddingLeft: 18 }}>{items}</ol>);
      continue;
    }

    // Plain paragraph
    nodes.push(<p key={key++} style={{ margin: '0 0 6px', color: '#e0e0e0' }}>{renderInline(trimmed)}</p>);
    i++;
  }

  return nodes;
}

/**
 * TextWidget — Renders markdown text blocks.
 * 
 * Used by the agent to display structured text, summaries,
 * key points, and step-by-step breakdowns.
 */
export function TextWidget({ data }: { data: TextWidgetData }) {
  return (
    <div style={{
      width: '100%',
      height: '100%',
      overflowY: 'auto',
      padding: '16px 18px',
      boxSizing: 'border-box',
      fontFamily: 'sans-serif',
      fontSize: 15,
      lineHeight: 1.7,
      color: '#e0e0e0',
    }}>
      {renderMarkdown(data.content)}
    </div>
  );
}
