import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';
import nodeAdapter from '@sveltejs/adapter-node';
import vercelAdapter from '@sveltejs/adapter-vercel';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default defineConfig(({ mode }) => ({
  plugins: [sveltekit({
    adapter: process.env.VERCEL === '1' ? vercelAdapter({ runtime: 'nodejs26.x' }) : nodeAdapter(),
    preprocess: vitePreprocess(),
    paths: { origin: loadEnv(mode, process.cwd(), '').APP_ORIGIN || undefined }
  })],
  optimizeDeps: { exclude: ['pdfjs-dist'] }
}));
