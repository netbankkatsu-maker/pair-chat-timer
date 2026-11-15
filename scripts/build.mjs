import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });
await build({ entryPoints: ['src/pages.js'], outfile: 'dist/_worker.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022' });
await writeFile('dist/_routes.json', JSON.stringify({ version: 1, include: ['/api/*'], exclude: [] }));
console.log('Built Cloudflare Pages output: dist/');
