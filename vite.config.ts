import { defineConfig } from 'vite'
import path from 'path'

export default defineConfig({
  root: './src',
  publicDir: '../public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: 'esbuild'
  },
  server: {
    port: process.env.PORT ? parseInt(process.env.PORT) : 5173,
    open: true,
    strictPort: false,
    watch: {
      usePolling: !!process.env.CHOKIDAR_USEPOLLING
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
})
