export type ImageWidgetData = {
  query: string;
  url: string | null;
};

/**
 * ImageWidget — Displays images and diagrams from Wikipedia.
 * 
 * Used by the agent to show visual illustrations that complement
 * the spoken explanation.
 */
export function ImageWidget({ data }: { data: ImageWidgetData }) {
  if (!data.url) {
    return (
      <div style={{
        width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#1a1a1a', color: '#555', fontSize: 13, fontFamily: 'monospace',
      }}>
        Searching for &ldquo;{data.query}&rdquo;&hellip;
      </div>
    );
  }

  return (
    // Outer div fills the cell and centers the square image
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#111',
    }}>
      {/* Inner div: aspect-ratio:1 + maxHeight:100% → constrained to the shorter dimension → true square */}
      <div style={{
        width: '100%',
        aspectRatio: '1 / 1',
        maxHeight: '100%',
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 4,
      }}>
        <img
          src={data.url}
          alt={data.query}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          background: 'linear-gradient(transparent, rgba(0,0,0,0.75))',
          padding: '16px 8px 6px',
          color: '#d0d0d0', fontSize: 11, fontFamily: 'sans-serif', letterSpacing: '0.02em',
        }}>
          {data.query}
        </div>
      </div>
    </div>
  );
}
