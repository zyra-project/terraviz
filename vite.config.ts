import { defineConfig } from 'vite'
import path from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as {
  version: string
}

export default defineConfig(({ mode }) => ({
  define: {
    __BUNDLED_DEV__: JSON.stringify(mode !== 'production'),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  root: './src',
  publicDir: '../public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'src/index.html'),
        orbit: path.resolve(__dirname, 'src/orbit.html'),
      },
    },
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
}))
