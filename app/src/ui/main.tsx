import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

// The desktop app (Electron) exposes `window.clipper` from its preload script: it runs in a
// see-through window, so the page switches to the light glass theme.
const glass = !!(window as unknown as { clipper?: unknown }).clipper || new URLSearchParams(location.search).has('glass');
if (glass) {
  document.documentElement.classList.add('glass');
} else {
  // A normal browser follows the system light/dark setting.
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => document.documentElement.classList.toggle('dark', mq.matches);
  apply();
  mq.addEventListener('change', apply);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
