import SyntaxHighlighter from 'react-syntax-highlighter';
import { atomOneDark } from 'react-syntax-highlighter/dist/esm/styles/hljs';
import './CodeViewer.css';

export interface CodeViewerData {
  language: string;
  code: string;
  highlight?: { start: number; end: number };
}

/**
 * CodeViewer — Displays syntax-highlighted code with line highlighting.
 * 
 * Used by the agent to show code snippets and walk through them
 * by highlighting specific line ranges.
 */
export function CodeViewer({ data }: { data: CodeViewerData }) {
  const hl = data.highlight;

  return (
    <div className="code-viewer">
      <div className="code-viewer-header">
        <span className="code-viewer-lang">{data.language}</span>
      </div>
      <div className="code-viewer-body">
        <SyntaxHighlighter
          language={data.language}
          style={atomOneDark}
          showLineNumbers
          wrapLines
          lineProps={(lineNumber) => {
            if (hl && lineNumber >= hl.start && lineNumber <= hl.end) {
              return {
                style: {
                  display: 'block',
                  backgroundColor: 'rgba(255, 200, 0, 0.15)',
                  borderLeft: '3px solid #ffc800',
                  marginLeft: '-3px',
                },
              };
            }
            return { style: { display: 'block' } };
          }}
          customStyle={{
            margin: 0,
            padding: '12px 16px',
            height: '100%',
            borderRadius: '0 0 8px 8px',
            fontSize: '0.8rem',
            lineHeight: '1.5',
            overflowY: 'auto',
          }}
          wrapLongLines={false}
        >
          {data.code}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}
