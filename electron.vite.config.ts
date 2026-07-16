import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: 'dist-electron/main' }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: 'dist-electron/preload' }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    build: { outDir: resolve('dist') }
  }
})
