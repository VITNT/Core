import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';
import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default defineConfig(({ mode }) => ({
  plugins: [sveltekit({ adapter: adapter(), preprocess: vitePreprocess(), paths: { origin: loadEnv(mode, process.cwd(), '').APP_ORIGIN || undefined } })],
  optimizeDeps: { exclude: ['pdfjs-dist'] }
}));
