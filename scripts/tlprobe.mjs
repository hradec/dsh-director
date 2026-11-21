import { build } from 'esbuild';
import { resolve } from 'node:path';
const root = process.cwd();
const r = await build({
  absWorkingDir: root,
  entryPoints: ['src/renderer/timeline/Timeline.tsx'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  loader: { '.css': 'text', '.svg': 'text' },
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  alias: {
    '@': resolve(root, 'src/renderer'),
    'react-i18next': resolve(root, 'src/renderer/shims/i18next-shim.jsx'),
    i18next: resolve(root, 'src/renderer/shims/i18next-shim.jsx'),
  },
  logLevel: 'silent',
});
console.log('OK bundle bytes:', r.outputFiles[0].text.length);
