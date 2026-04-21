import './index.css';

import { StrictMode, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ShowcaseApp } from './ShowcaseApp';
import { SplashApp } from './SplashApp';

function Router() {
  const [type, setType] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/post-type')
      .then(r => r.json())
      .then(d => setType(d.type))
      .catch(() => setType('canvas'));
  }, []);

  if (!type) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', background: '#000', color: '#666', fontFamily: 'system-ui' }}>
        Loading Kinora...
      </div>
    );
  }

  if (type === 'showcase') return <ShowcaseApp />;
  if (type === 'splash') return <SplashApp />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Router />
  </StrictMode>
);

