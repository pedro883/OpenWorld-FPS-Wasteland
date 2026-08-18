import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5173, host: '127.0.0.1' },
  build: {
    target: 'es2022',
    // Rapier's WASM is large; keep it in its own chunk so gameplay code
    // can be re-downloaded independently of the physics engine.
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          rapier: ['@dimforge/rapier3d-compat'],
        },
      },
    },
  },
  // rapier3d-compat ships inlined base64 WASM; excluding it from pre-bundling
  // avoids esbuild choking on the >4 MB module.
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
