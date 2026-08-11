import * as esbuild from 'esbuild';
import { cp, rm, mkdir } from 'node:fs/promises';

const BACKEND = process.env.BIDIT_BACKEND ?? 'https://bidit-backend-fekn.onrender.com';
const WEB = process.env.BIDIT_WEB ?? 'https://www.biditsol.com';
console.log(`[build] backend = ${BACKEND}`);
console.log(`[build] web     = ${WEB}`);

const common = {
  bundle: true,
  target: 'chrome114',
  logLevel: 'info',
  // panel.css is imported as a string and injected into the panel's shadow root.
  loader: { '.css': 'text' },
  // Baked-in URLs (overridable with BIDIT_BACKEND / BIDIT_WEB for local dev).
  define: {
    __BIDIT_BACKEND__: JSON.stringify(BACKEND),
    __BIDIT_WEB__: JSON.stringify(WEB),
  },
};

await rm('dist', { recursive: true, force: true });
await rm('dist-preview', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await mkdir('dist-preview', { recursive: true });

// Service worker + popup are ES modules.
await esbuild.build({
  ...common,
  format: 'esm',
  entryPoints: { background: 'src/background.ts', popup: 'src/popup.ts' },
  outdir: 'dist',
});

// Content scripts must be classic scripts (not ES modules).
await esbuild.build({
  ...common,
  format: 'iife',
  entryPoints: { content: 'src/content.ts' },
  outdir: 'dist',
});

// Standalone panel screenshot harness.
await esbuild.build({
  ...common,
  format: 'iife',
  entryPoints: { preview: 'dev/preview-entry.ts' },
  outdir: 'dist-preview',
});

await cp('manifest.json', 'dist/manifest.json');
await cp('popup.html', 'dist/popup.html');
await cp('icons', 'dist/icons', { recursive: true });
await cp('dev/panel-preview.html', 'dist-preview/index.html');

console.log('\nBuilt dist/ (load unpacked in chrome://extensions) + dist-preview/ (panel harness)');
