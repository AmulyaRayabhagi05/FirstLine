import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './hud/ErrorBoundary';
import { startLive } from './data/live';
import './styles.css';

// Demo login: when running locally (`npm run dev`), sign in with the key in web/admin.local.json,
// made by `npx tsx scripts/admin.ts`. The file is git-ignored, and production builds skip this
// block entirely (import.meta.env.DEV is false there), so the key never ships.
async function adminKey(): Promise<string | undefined> {
  if (!import.meta.env.DEV) return undefined;
  try {
    const res = await fetch('/admin.local.json', { cache: 'no-store' });
    if (!res.ok) return undefined;
    const file = (await res.json()) as { accessKey?: unknown };
    return typeof file.accessKey === 'string' && file.accessKey ? file.accessKey : undefined;
  } catch {
    return undefined; // no admin file: the normal sign-in screen shows
  }
}

adminKey().then((key) => (key ? startLive(key) : startLive()));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="FirstLine">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
