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
        display: 'flex', flexDirection: 'column', gap: 8,
        alignItems: 'center', justifyContent: 'center',
        textAlign: 'center', padding: '0 18px',
        background: 'var(--surface)', color: 'var(--text-muted)', fontSize: 13, fontFamily: 'var(--font-mono)',
      }}>
        <span>No image found</span>
        <span style={{ opacity: 0.65 }}>&ldquo;{data.query}&rdquo;</span>
      </div>
    );
  }

  return (
    // Outer div fills the cell and centers the square image
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--code-bg)',
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
          color: 'var(--text-secondary)', fontSize: 11, fontFamily: 'var(--font-sans)', letterSpacing: '0.02em',
        }}>
          {data.query}
        </div>
      </div>
    </div>
  );
}
