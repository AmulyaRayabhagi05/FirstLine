import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { DATA_MODE } from './data/spacetime';
import { startLive } from './data/live';
import './styles.css';

if (DATA_MODE === 'live') startLive();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
