import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { connect, DEMO, startDemo } from './conn';
import './styles.css';

// ?demo shows a sample resident without connecting; otherwise this phone's own account.
if (DEMO) startDemo();
else connect();

// Installable app that opens offline: the service worker caches the app shell.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
