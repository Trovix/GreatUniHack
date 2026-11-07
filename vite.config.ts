import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig({root:'apps/extension',base:'./',plugins:[react()],build:{outDir:'../../dist/extension',emptyOutDir:true,rollupOptions:{input:{workspace:resolve('apps/extension/workspace.html'),sidepanel:resolve('apps/extension/sidepanel.html')}}}});
