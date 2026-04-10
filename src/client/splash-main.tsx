import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SplashApp } from './app/SplashApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SplashApp />
  </StrictMode>
);
