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
  /** Build-time override for the initial UI scale (§7.1). Used by
   *  the SOS deployment to ship `1.5` as the first-launch default
   *  for the kiosk audience. Falls back to `1.0` when unset.
   *  Anything outside the [0.5, 2.0] band is rejected. */
  readonly VITE_DEFAULT_UI_SCALE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Minimal type shim for `cytoscape-cola`. The package ships no
 *  TypeScript types and DefinitelyTyped has no `@types/cytoscape-cola`.
 *  The default export is a cytoscape extension registrar — call
 *  `cytoscape.use(cola)` once before instantiating to register the
 *  `'cola'` layout name. Layout options are then passed via the
 *  cytoscape layout config; cytoscape's own types treat layout
 *  options as `any`, so no further shape is needed here. */
declare module 'cytoscape-cola' {
  import type cytoscape from 'cytoscape'
  const cola: cytoscape.Ext
  export default cola
}
