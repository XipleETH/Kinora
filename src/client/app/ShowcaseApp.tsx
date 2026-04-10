import React, { useEffect, useState } from 'react';

interface ShowcaseData {
  week: number;
  theme: string;
  paletteName: string;
  paletteColors: string[];
  brushKitName: string;
  brushNames: string[];
  directorName: string;
  startDate: string;
  endDate: string;
}

export const ShowcaseApp: React.FC = () => {
  const [data, setData] = useState<ShowcaseData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/showcase-data');
        if (!res.ok) throw new Error('Failed to load');
        const json = await res.json();
        setData(json);
      } catch (e: any) {
        setError(e?.message || 'Error');
      }
    })();
  }, []);

  if (error) return <div style={styles.loading}>⚠️ {error}</div>;
  if (!data) return <div style={styles.loading}>Loading...</div>;

  const colors = data.paletteColors.length > 0
    ? data.paletteColors
    : ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD'];

  return (
    <div style={styles.container}>
      <div style={styles.clapperboard}>
        {/* Top bar with color stripes */}
        <div style={styles.topBar}>
          <div style={styles.stripes}>
            {colors.map((c, i) => (
              <div key={i} style={{ ...styles.stripe, background: c }} />
            ))}
          </div>
          <div style={styles.topBarOverlay}>
            <span style={styles.kinora}>KINORA</span>
            <span style={styles.weekBadge}>WEEK {data.week}</span>
          </div>
        </div>

        {/* Hinge dots */}
        <div style={styles.hinge}>
          <div style={styles.hingeDot} />
          <div style={styles.hingeDot} />
        </div>

        {/* Body */}
        <div style={styles.body}>
          {/* Theme row */}
          <div style={styles.fieldRow}>
            <div style={styles.fieldLabel}>THEME</div>
            <div style={styles.fieldValue}>{data.theme || '—'}</div>
          </div>

          <div style={styles.divider} />

          {/* Director row */}
          <div style={styles.fieldRow}>
            <div style={styles.fieldLabel}>DIRECTOR</div>
            <div style={styles.fieldValue}>u/{data.directorName || 'unknown'}</div>
          </div>

          <div style={styles.divider} />

          {/* Palette row */}
          <div style={styles.fieldRow}>
            <div style={styles.fieldLabel}>PALETTE</div>
            <div style={{ ...styles.fieldValue, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {colors.map((c, i) => (
                <div
                  key={i}
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    background: c,
                    border: '2px solid rgba(255,255,255,0.3)',
                    boxShadow: `0 0 6px ${c}44`,
                  }}
                  title={c}
                />
              ))}
            </div>
          </div>

          <div style={styles.divider} />

          {/* Brushes row */}
          <div style={styles.fieldRow}>
            <div style={styles.fieldLabel}>BRUSHES</div>
            <div style={styles.fieldValue}>
              {data.brushNames.length > 0 ? data.brushNames.join(' • ') : data.brushKitName || '—'}
            </div>
          </div>

          <div style={styles.divider} />

          {/* Date row */}
          <div style={styles.fieldRow}>
            <div style={styles.fieldLabel}>DATE</div>
            <div style={styles.fieldValue}>{data.startDate} → {data.endDate}</div>
          </div>
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <span style={{ opacity: 0.5, fontSize: 10, letterSpacing: 2 }}>COLLABORATIVE ANIMATION</span>
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: '100%',
    padding: 8,
    fontFamily: "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif",
    background: 'linear-gradient(145deg, #0a0a0f 0%, #1a1a2e 50%, #16213e 100%)',
    boxSizing: 'border-box' as const,
    overflowX: 'hidden' as const,
    width: '100%',
    maxWidth: '100vw',
  },
  loading: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: 200,
    color: '#aaa',
    fontFamily: 'sans-serif',
    fontSize: 14,
  },
  clapperboard: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 12,
    overflow: 'hidden',
    boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3)',
    background: '#1c1c28',
    border: '1px solid rgba(255,255,255,0.08)',
  },
  topBar: {
    position: 'relative' as const,
    height: 56,
    overflow: 'hidden',
  },
  stripes: {
    display: 'flex',
    height: '100%',
    width: '100%',
  },
  stripe: {
    flex: 1,
    minWidth: 0,
    transform: 'skewX(-15deg) scaleX(1.3)',
  },
  topBarOverlay: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 16px',
    background: 'linear-gradient(180deg, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.4) 100%)',
  },
  kinora: {
    fontSize: 22,
    fontWeight: 900,
    color: '#fff',
    letterSpacing: 4,
    textShadow: '0 2px 8px rgba(0,0,0,0.6)',
  },
  weekBadge: {
    fontSize: 11,
    fontWeight: 700,
    color: '#fff',
    background: 'rgba(0,0,0,0.5)',
    padding: '4px 10px',
    borderRadius: 20,
    letterSpacing: 1,
  },
  hinge: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '0 20px',
    height: 8,
    background: '#111118',
    alignItems: 'center',
  },
  hingeDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#555',
  },
  body: {
    padding: '12px 16px',
  },
  fieldRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '8px 0',
  },
  fieldLabel: {
    fontSize: 9,
    fontWeight: 700,
    color: 'rgba(255,255,255,0.4)',
    letterSpacing: 2,
    minWidth: 64,
    paddingTop: 3,
    textTransform: 'uppercase' as const,
  },
  fieldValue: {
    fontSize: 14,
    fontWeight: 600,
    color: '#e8e8f0',
    flex: 1,
  },
  divider: {
    height: 1,
    background: 'rgba(255,255,255,0.06)',
    margin: '0 -4px',
  },
  footer: {
    padding: '8px 16px 12px',
    textAlign: 'center' as const,
    color: '#888',
  },
};
