import { defineConfig, loadEnv } from 'vite'
import path from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as {
  version: string
}

/** Validate and normalize the build-channel env var so a typo
 * doesn't leak a bespoke string into `session_start.build_channel`.
 * Reads from the merged env object so .env.local + shell env
 * follow the same precedence as every other VITE_* knob. */
function resolveBuildChannel(env: Record<string, string>): 'public' | 'internal' | 'canary' {
  const raw = process.env.VITE_BUILD_CHANNEL ?? env.VITE_BUILD_CHANNEL
  if (raw === 'internal' || raw === 'canary') return raw
  return 'public'
}

export default defineConfig(({ mode }) => {
  // Vite's `root` is `./src`, but contributors expect `.env.local`
  // at the repo root (the standard convention everywhere else). The
  // `envDir` override + an explicit loadEnv() lets us read the
  // root-level file so the dev-server proxy below can read
  // `VITE_DEV_API_TARGET` from it without contributors having to
  // know about the src/ root quirk.
  const envDir = path.resolve(__dirname)
  const env = loadEnv(mode, envDir, 'VITE_')

  return {
    define: {
      __BUNDLED_DEV__: JSON.stringify(mode !== 'production'),
      __APP_VERSION__: JSON.stringify(pkg.version),
      // Baked in at build time. Internal / canary bundles are tagged
      // so dashboards can filter them out of public-user rollups
      // without needing IP-based allowlists. Default `'public'`.
      __BUILD_CHANNEL__: JSON.stringify(resolveBuildChannel(env)),
    },
    root: './src',
    publicDir: '../public',
    envDir,
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
      // VITE_HOST=0.0.0.0 lets dev-container contributors expose the
      // server on every interface so the host browser can reach it.
      // Default stays `localhost` so a host-shell run keeps the same
      // private-network behaviour. The HMR client also reads this so
      // the WebSocket URL the browser sees stays consistent with the
      // forwarded port (set `VITE_HMR_CLIENT_PORT` to match the host
      // port if your dev container forwards to a different number).
      host: process.env.VITE_HOST ?? env.VITE_HOST ?? 'localhost',
      open: true,
      strictPort: false,
      watch: {
        usePolling: !!process.env.CHOKIDAR_USEPOLLING,
      },
      hmr:
        process.env.VITE_HMR_CLIENT_PORT || env.VITE_HMR_CLIENT_PORT
          ? {
              clientPort: Number(
                process.env.VITE_HMR_CLIENT_PORT ?? env.VITE_HMR_CLIENT_PORT,
              ),
            }
          : undefined,
      // The dev server proxies `/api/*` to a backend so the frontend
      // can run against either:
      //   - the production catalog (default), or
      //   - a locally running `wrangler pages dev` at :8788, by setting
      //     `VITE_DEV_API_TARGET=http://localhost:8788` in `.env.local`
      //     before running `npm run dev`.
      // The two-port split keeps Vite's HMR-friendly :5173 separate
      // from Wrangler's Functions runtime; same-origin from the
      // browser's perspective via this proxy.
      proxy: {
        '/api': {
          target:
            process.env.VITE_DEV_API_TARGET ??
            env.VITE_DEV_API_TARGET ??
            'https://terraviz.zyra-project.org',
          changeOrigin: true,
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  }
})
