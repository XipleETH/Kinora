import React from 'react';
import { requestExpandedMode } from '@devvit/web/client';

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

export const SplashApp: React.FC = () => {
  const handleAnimate = (e: React.MouseEvent) => {
    requestExpandedMode(e.nativeEvent, 'app');
  };

  const features = [
    { icon: <IconPalette />, label: 'Canvas' },
    { icon: <IconImage />, label: 'Gallery' },
    { icon: <IconVote />, label: 'Voting' },
    { icon: <IconChat />, label: 'Chat' },
  ];

  return (
    <div className="splash-root">
      <style>{`
        .splash-root {
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100%;
          padding: 6px;
          font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
          background: #FAF3E0;
          box-sizing: border-box;
          overflow: hidden;
          width: 100%;
          background-image: radial-gradient(rgba(0,0,0,0.04) 1px, transparent 1px);
          background-size: 14px 14px;
        }
        .splash-root *, .splash-root *::before, .splash-root *::after {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }

        .splash-card {
          width: 100%;
          max-width: 340px;
          border: 2px solid #111;
          border-radius: 10px;
          box-shadow: 2px 2px 0 #111, 4px 4px 0 rgba(0,0,0,0.25);
          background: #FAF3E0;
          overflow: hidden;
        }

        /* B/W stripes */
        .splash-stripes {
          display: flex;
          height: 44px;
          border-bottom: 2px solid #111;
        }
        .splash-stripe {
          flex: 1;
          min-width: 0;
          transform: skewX(-15deg) scaleX(1.3);
        }
        .splash-stripe:nth-child(odd) { background: #111; }
        .splash-stripe:nth-child(even) { background: #FAF3E0; }

        /* Hinge */
        .splash-hinge {
          display: flex;
          justify-content: space-between;
          padding: 0 18px;
          height: 10px;
          align-items: center;
          border-bottom: 2px solid #111;
        }

        /* Body */
        .splash-body {
          padding: 14px 20px 14px;
          display: flex;
          flex-direction: column;
          align-items: center;
        }

        .splash-kinora {
          font-size: 24px;
          font-weight: 900;
          color: #111;
          letter-spacing: 7px;
          text-transform: uppercase;
          margin-bottom: 12px;
        }

        /* Features — vertical list, left-aligned */
        .splash-features {
          width: 100%;
          margin-bottom: 8px;
          padding-left: 8px;
        }
        .splash-feat {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 7px 0;
        }
        .splash-feat-icon {
          width: 22px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          opacity: 0.7;
        }
        .splash-feat-text {
          font-size: 11px;
          font-weight: 700;
          color: #111;
          letter-spacing: 2px;
          text-transform: uppercase;
          opacity: 0.5;
        }
        .splash-divider {
          height: 1px;
          background: #111;
          opacity: 0.08;
        }

        /* Animate button — centered */
        .splash-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          width: 170px;
          padding: 10px 20px;
          border: 2px solid #111;
          border-radius: 8px;
          box-shadow: 2px 2px 0 #111;
          background: #FAF3E0;
          background-image: repeating-linear-gradient(135deg, rgba(0,0,0,0.04) 0 3px, transparent 3px 6px);
          font-size: 14px;
          font-weight: 800;
          color: #111;
          letter-spacing: 2.5px;
          text-transform: uppercase;
          cursor: pointer;
          transition: transform 0.12s ease, box-shadow 0.12s ease;
          font-family: inherit;
        }
        .splash-btn:hover {
          transform: translate(-1px, -1px);
          box-shadow: 3px 3px 0 #111;
        }
        .splash-btn:active {
          transform: translate(0, 0);
          box-shadow: 1px 1px 0 #111;
        }

        /* Footer */
        .splash-footer {
          padding: 6px 16px 10px;
          text-align: center;
          font-size: 8px;
          font-weight: 600;
          color: #111;
          opacity: 0.2;
          letter-spacing: 2px;
          text-transform: uppercase;
        }
      `}</style>

      <div className="splash-card">
        <div className="splash-stripes">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="splash-stripe" />
          ))}
        </div>

        <div className="splash-hinge">
          <div style={{ width: 5, height: 5, borderRadius: '50%', border: '1.5px solid #111' }} />
          <div style={{ width: 5, height: 5, borderRadius: '50%', border: '1.5px solid #111' }} />
        </div>

        <div className="splash-body">
          <span className="splash-kinora">KINORA</span>

          <div className="splash-features">
            {features.map((f, i) => (
              <React.Fragment key={f.label}>
                {i > 0 && <div className="splash-divider" />}
                <div className="splash-feat">
                  <span className="splash-feat-icon">{f.icon}</span>
                  <span className="splash-feat-text">{f.label}</span>
                </div>
              </React.Fragment>
            ))}
          </div>

          <button className="splash-btn" onClick={handleAnimate}>
            <span>▶</span>
            <span>Animate</span>
          </button>
        </div>

        <div className="splash-footer">Collaborative Animation</div>
      </div>
    </div>
  );
};
