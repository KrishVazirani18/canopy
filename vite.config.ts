import fs from 'node:fs';
import path from 'node:path';
import { build, defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The widget frame's own page (renderer/src/frame) runs inside a sandboxed iframe that has no URL to load scripts
// from, so its code travels as text in the iframe's srcdoc. This bundles it into one script and hands it to the app
// as a string: `import frameJs from 'virtual:canopy-frame'`.
function canopyFrame(): Plugin {
  const id = 'virtual:canopy-frame';
  const entry = path.resolve(import.meta.dirname, 'renderer/src/frame/main.ts');
  return {
    name: 'canopy-frame',
    resolveId(source) { return source === id ? `\0${id}` : undefined; },
    async load(loaded) {
      if (loaded !== `\0${id}`) return undefined;
      const out = await build({
        configFile: false, logLevel: 'warn',
        build: { write: false, minify: true, target: 'chrome130', lib: { entry, formats: ['iife'], name: 'CanopyFrame' } },
      });
      const chunk = (Array.isArray(out) ? out : [out]).flatMap((o) => ('output' in o ? o.output : [])).find((o) => o.type === 'chunk');
      if (!chunk || chunk.type !== 'chunk') throw new Error('The widget frame did not build.');
      // Editing any file of the frame rebuilds the app (the dev watcher runs `vite build --watch`).
      for (const file of Object.keys(chunk.modules)) if (path.isAbsolute(file)) this.addWatchFile(file);
      return `export default ${JSON.stringify(chunk.code)};`;
    },
  };
}

// The Playground lists every file in renderer/src/playground/mocks (an import.meta.glob). The dev watcher
// (`vite build --watch`) only watches files it already bundled, so a new mock was never picked up: it is told to
// watch the folder, and a file added to it or taken out of it marks the Playground itself changed, which reads the
// folder again.
function playgroundMocks(): Plugin {
  const dir = path.resolve(import.meta.dirname, 'renderer/src/playground/mocks');
  const playground = path.resolve(import.meta.dirname, 'renderer/src/playground/playground.tsx');
  return {
    name: 'canopy-playground-mocks',
    apply: 'build',
    buildStart() { if (this.meta.watchMode) this.addWatchFile(dir); },
    watchChange(id, { event }) {
      if (event === 'update' || path.dirname(id) !== dir) return;
      try { const now = new Date(); fs.utimesSync(playground, now, now); } catch { /* the next edit picks it up */ }
    },
  };
}

// The renderer (UI) lives in ./renderer. Electron loads the dev server in dev
// and the built files from ./dist-ui in a packaged app.
export default defineConfig({
  root: path.resolve(import.meta.dirname, 'renderer'),
  base: './',
  plugins: [canopyFrame(), playgroundMocks(), react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'renderer/src') } },
  server: { port: 5174, strictPort: false },
  // The dev watcher (CANOPY_DEV_WATCH=1) never empties dist-ui: a window loading mid-rebuild would find its files gone.
  build: { outDir: path.resolve(import.meta.dirname, 'dist-ui'), emptyOutDir: process.env.CANOPY_DEV_WATCH !== '1' },
});
