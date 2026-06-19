import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import UnoCSS from '@unocss/vite';
import { nip5aManifest } from '@napplet/vite-plugin';

export default defineConfig({
  plugins: [UnoCSS(), svelte(), nip5aManifest({ nappletType: 'radio', requires: ['relay', 'ifc', 'storage', 'player', 'resource'], artifactMode: 'single-file' })],
  resolve: {
    dedupe: ['svelte'],
  },
  server: {
    port: 5181,
    cors: true,
  },
  build: {
    outDir: 'dist',
  },
});
