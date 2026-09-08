import { useEffect, useState } from 'react';

export type ImageWidgetData = {
  query: string;
  urls: string[];
};

/**
 * ImageWidget — Displays images and diagrams from Wikipedia.
 *
 * The backend supplies multiple candidate URLs; if one fails to load, the
 * widget advances to the next automatically instead of showing a broken tile.
 */
export function ImageWidget({ data }: { data: ImageWidgetData }) {
  const urls = data.urls ?? [];
  const [index, setIndex] = useState(0);

  // Reset to the first candidate whenever a new query arrives.
  useEffect(() => {
    setIndex(0);
  }, [data.query]);

  if (urls.length === 0) {
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

  // Guard against a new query that returns fewer candidates than the old index.
  const currentIndex = Math.min(index, urls.length - 1);
  const current = urls[currentIndex];

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
          src={current}
          alt={data.query}
          onError={() => {
            // Advance to the next candidate on load failure.
            if (currentIndex < urls.length - 1) setIndex(currentIndex + 1);
          }}
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        />
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          background: 'linear-gradient(transparent, rgba(0,0,0,0.75))',
          padding: '16px 8px 6px',
          color: 'var(--text-secondary)', fontSize: 11, fontFamily: 'var(--font-sans)', letterSpacing: '0.02em',
        }}>
          {data.query}{urls.length > 1 ? ` · ${currentIndex + 1}/${urls.length}` : ''}
        </div>
      </div>
    </div>
  );
}
