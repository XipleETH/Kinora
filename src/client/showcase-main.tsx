import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ShowcaseApp } from './app/ShowcaseApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ShowcaseApp />
  </StrictMode>
);
