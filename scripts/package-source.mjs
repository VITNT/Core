import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
mkdirSync(resolve(root, 'static'), { recursive: true });
execFileSync('tar', ['-czf', resolve(root, 'static/source.tar.gz'), '--',
  'src', 'scripts', 'server-assets', 'tests', 'docs', 'static/favicon.svg',
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
  'tailwind.config.ts', 'postcss.config.js', 'Dockerfile', '.dockerignore',
  '.env.example', '.gitignore', 'README.md', 'THIRD_PARTY.md', 'LICENSE', 'NOTICE'
], { cwd: root, stdio: 'inherit' });
console.log('Corresponding source packaged at /source.tar.gz');
