import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served at /app/ next to the dashboard (deploy/vultr/deploy.sh copies dist into web/dist/app).
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  build: { outDir: 'dist', target: 'es2020' },
});
