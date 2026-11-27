import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

// The desktop app (Electron) exposes `window.clipper` from its preload script: it runs in a
// see-through window, so the page switches to the glass theme.
if ((window as unknown as { clipper?: unknown }).clipper || new URLSearchParams(location.search).has('glass')) {
  document.documentElement.classList.add('glass');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
