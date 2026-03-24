import { defineConfig } from 'vite'
import path from 'path'

export default defineConfig({
  define: {
    __BUNDLED_DEV__: JSON.stringify(false),
  },
  root: './src',
  publicDir: '../public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: true
  },
  server: {
    port: process.env.PORT ? parseInt(process.env.PORT) : 5173,
    open: true,
    strictPort: false,
    watch: {
      usePolling: !!process.env.CHOKIDAR_USEPOLLING
    },
    proxy: {
      '/api': {
        target: 'https://sphere.zyra-project.org',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
})
