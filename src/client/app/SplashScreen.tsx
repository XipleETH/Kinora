import React from 'react';

/* Inline SVG icons matching lucide icons from the app (B/W) */
const IconPalette = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="13.5" cy="6.5" r="0.5" fill="#111"/>
    <circle cx="17.5" cy="10.5" r="0.5" fill="#111"/>
    <circle cx="8.5" cy="7.5" r="0.5" fill="#111"/>
    <circle cx="6.5" cy="12" r="0.5" fill="#111"/>
    <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>
  </svg>
);

const IconImage = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>
    <circle cx="9" cy="9" r="2"/>
    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
  </svg>
);

const IconVote = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m9 12 2 2 4-4"/>
    <path d="M5 7c0-1.1.9-2 2-2h10a2 2 0 0 1 2 2v12H5V7Z"/>
    <path d="M22 19H2"/>
  </svg>
);

const IconChat = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>
  </svg>
);

interface SplashScreenProps {
  onAnimate: () => void;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({ onAnimate }) => {
  const features = [
    { icon: <IconPalette />, label: 'Canvas' },
    { icon: <IconImage />, label: 'Gallery' },
    { icon: <IconVote />, label: 'Voting' },
    { icon: <IconChat />, label: 'Chat' },
  ];

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        width: '100%',
        padding: 12,
        fontFamily: "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif",
        background: '#FAF3E0',
        backgroundImage: 'radial-gradient(rgba(0,0,0,0.04) 1px, transparent 1px)',
        backgroundSize: '14px 14px',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      <div style={styles.card}>
        {/* B/W stripes */}
        <div style={styles.stripes}>
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} style={{ ...styles.stripe, background: i % 2 === 0 ? '#111' : '#FAF3E0' }} />
          ))}
        </div>

        {/* Hinge */}
        <div style={styles.hinge}>
          <div style={styles.hingeDot} />
          <div style={styles.hingeDot} />
        </div>

        {/* Body */}
        <div style={styles.body}>
          <span style={styles.kinora}>KINORA</span>

          <div style={styles.features}>
            {features.map((f, i) => (
              <React.Fragment key={f.label}>
                {i > 0 && <div style={styles.divider} />}
                <div style={styles.feat}>
                  <span style={styles.featIcon}>{f.icon}</span>
                  <span style={styles.featText}>{f.label}</span>
                </div>
              </React.Fragment>
            ))}
          </div>

          <button style={styles.btn} onClick={onAnimate}>
            <span>▶</span>
            <span>Animate</span>
          </button>
        </div>

        <div style={styles.footer}>Collaborative Animation</div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  card: {
    width: '100%',
    maxWidth: 340,
    border: '2px solid #111',
    borderRadius: 10,
    boxShadow: '2px 2px 0 #111, 4px 4px 0 rgba(0,0,0,0.25)',
    background: '#FAF3E0',
    overflow: 'hidden',
  },
  stripes: {
    display: 'flex',
    height: 22,
    borderBottom: '2px solid #111',
  },
  stripe: {
    flex: 1,
    minWidth: 0,
    transform: 'skewX(-15deg) scaleX(1.3)',
  },
  hinge: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '0 18px',
    height: 7,
    alignItems: 'center',
  },
  hingeDot: {
    width: 4,
    height: 4,
    borderRadius: '50%',
    border: '1.5px solid #111',
  },
  body: {
    padding: '14px 20px 14px',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
  },
  kinora: {
    fontSize: 24,
    fontWeight: 900,
    color: '#111',
    letterSpacing: 7,
    textTransform: 'uppercase' as const,
    marginBottom: 12,
  },
  features: {
    width: '100%',
    paddingLeft: 8,
    marginBottom: 8,
  },
  feat: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '7px 0',
  },
  featIcon: {
    width: 22,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    opacity: 0.7,
  },
  featText: {
    fontSize: 11,
    fontWeight: 700,
    color: '#111',
    letterSpacing: 2,
    textTransform: 'uppercase' as const,
    opacity: 0.5,
  },
  divider: {
    height: 1,
    background: '#111',
    opacity: 0.08,
  },
  btn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    width: 170,
    padding: '10px 20px',
    border: '2px solid #111',
    borderRadius: 8,
    boxShadow: '2px 2px 0 #111',
    background: '#FAF3E0',
    backgroundImage: 'repeating-linear-gradient(135deg, rgba(0,0,0,0.04) 0 3px, transparent 3px 6px)',
    fontSize: 14,
    fontWeight: 800,
    color: '#111',
    letterSpacing: 2.5,
    textTransform: 'uppercase' as const,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  footer: {
    padding: '6px 16px 10px',
    textAlign: 'center' as const,
    fontSize: 8,
    fontWeight: 600,
    color: '#111',
    opacity: 0.2,
    letterSpacing: 2,
    textTransform: 'uppercase' as const,
  },
};
