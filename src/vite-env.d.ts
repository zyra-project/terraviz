/// <reference types="vite/client" />

/** App version, injected by Vite `define` from package.json. */
declare const __APP_VERSION__: string

interface ImportMetaEnv {
  /** Compile-time telemetry kill switch. When `'false'`, the emitter
   * dead-code-eliminates its bodies at build time. See
   * `docs/ANALYTICS_IMPLEMENTATION_PLAN.md`. */
  readonly VITE_TELEMETRY_ENABLED?: string
  /** When `'true'`, the emitter logs batches to `console.debug`
   * instead of sending them. Default on in `npm run dev`. */
  readonly VITE_TELEMETRY_CONSOLE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
