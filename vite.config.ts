import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import UnoCSS from '@unocss/vite';
import { nip5aManifest } from '@napplet/vite-plugin';

export default defineConfig({
  plugins: [
    UnoCSS(),
    svelte(),
    nip5aManifest({
      nappletType: 'radio',
      // 'intent' lets the runtime deliver napplet:radio/play here; the target
      // policy refuses delivery to an app that does not require the domain.
      requires: ['relay', 'inc', 'intent', 'storage', 'media', 'resource'],
      optional: ['theme'],
      archetypes: [{ slug: 'radio', convention: 'napplet:radio/play', params: ['query', 'station'] }],
      icon: { data: readFileSync(new URL('./icon.png', import.meta.url)), mimeType: 'image/png' },
      artifactMode: 'single-file',
    }),
  ],
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
