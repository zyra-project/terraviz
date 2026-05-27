/**
 * Shader tuner — §7.2 dev-only floating panel.
 *
 * Mounted only when the URL carries `?tune=shader`. Renders four
 * sliders (contrast, saturation, specular strength, bump strength)
 * each wired to shaderSettingsService.setTunerValue(). Slider
 * drags re-render the globe live via the same change-event channel
 * the Tools-menu specular preset uses — pick the values that look
 * right, then edit `SHADER_DEFAULTS` in shaderSettingsService and
 * ship them as the new defaults.
 *
 * Tuner writes do NOT persist (the service intentionally only
 * persists the user-facing specular preset). Reload at `?tune=
 * shader` boots from the shipped SHADER_DEFAULTS each time — you're
 * tuning the SHIP defaults, not your personal preference.
 *
 * i18n exemption: every string in this module is a dev-debug
 * surface — slider labels are uniform names (`Contrast`, etc.)
 * that map 1:1 to GLSL identifiers, and the "Copy defaults"
 * button is for engineers editing SHADER_DEFAULTS. Routing them
 * through Weblate would force translators to localise terms that
 * have no meaning outside the codebase. The per-line
 * `// i18n-exempt` annotations make the omission explicit so the
 * static check (`npm run check:i18n-strings`) doesn't flag them.
 */

import {
  getShaderSettings,
  onShaderSettingsChange,
  setTunerValue,
  SHADER_DEFAULTS,
  TUNER_BANDS,
  type ShaderSettings,
} from '../services/shaderSettingsService'
import { logger } from '../utils/logger'

const HOST_ID = 'shader-tuner'

interface SliderRow {
  key: keyof ShaderSettings
  /** Human-readable label rendered next to the slider. */
  label: string
  /** Compact key (matches the uniform name in GLSL) for the
   *  copy-defaults JSON line. */
  shortKey: string
}

const ROWS: readonly SliderRow[] = [
  { key: 'contrast', label: 'Contrast', shortKey: 'contrast' }, // i18n-exempt: dev-tuner label
  { key: 'saturation', label: 'Saturation', shortKey: 'saturation' }, // i18n-exempt: dev-tuner label
  { key: 'specularStrength', label: 'Specular', shortKey: 'specularStrength' }, // i18n-exempt: dev-tuner label
  { key: 'bumpStrength', label: 'Bump', shortKey: 'bumpStrength' }, // i18n-exempt: dev-tuner label
]

/**
 * Conditionally boot the shader tuner — only when the URL contains
 * `?tune=shader`. Called once from main.ts. No-op in every other
 * environment so the tuner has zero cost outside dev sessions.
 */
export function maybeInitShaderTuner(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  const params = new URLSearchParams(window.location.search)
  if (params.get('tune') !== 'shader') return
  // Defer mount until DOMContentLoaded so #ui (the existing
  // pointer-events container) is in the tree to attach to.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountTuner, { once: true })
  } else {
    mountTuner()
  }
}

function mountTuner(): void {
  if (document.getElementById(HOST_ID)) return
  const host = document.createElement('div')
  host.id = HOST_ID
  applyHostStyles(host)
  host.innerHTML = buildPanelHtml()
  // Prefer the dedicated `#ui` overlay container (pointer-events:
  // none with opt-in `pointer-events: auto` on its panels — see
  // base.css) so the tuner stacks naturally with browse/chat/etc.
  // and doesn't intercept clicks meant for the map. Fall back to
  // <body> if the SPA shell hasn't built #ui yet (very early
  // ?tune=shader load), where the inline `pointer-events: auto` on
  // the host element keeps it interactive.
  const ui = document.getElementById('ui')
  ;(ui ?? document.body).appendChild(host)
  wireSliders(host)
  wireCopyButton(host)
  // External changes (Tools-menu specular click, programmatic
  // setSpecularPreset call) should refresh the slider positions
  // so the tuner stays an accurate mirror of the live state. The
  // unsubscribe handle is passed through to the close-button wiring
  // so a panel dismiss tears the listener down — without that, a
  // closed panel keeps a detached `host` reachable via the event
  // target and every settings change would do dead DOM work
  // forever.
  const unsubscribe = onShaderSettingsChange((s) => syncSliders(host, s))
  wireCloseButton(host, unsubscribe)
  wireResetButton(host)
  logger.info('[shaderTuner] mounted (?tune=shader)')
}

/**
 * Inline styles — keeps the tuner module self-contained and
 * leaves the shipped stylesheet unaffected (the dev tuner should
 * not bloat tokens.css or component CSS for production users).
 * Glass-panel look matches the rest of the UI, sits top-right
 * above the Tools popover so the two don't overlap. position:
 * fixed deliberately — the tuner shouldn't move with map pans.
 */
function applyHostStyles(host: HTMLElement): void {
  Object.assign(host.style, {
    position: 'fixed',
    top: '0.75rem',
    right: '0.75rem',
    zIndex: '1000',
    padding: '0.6rem 0.8rem',
    background: 'rgba(13, 13, 18, 0.94)',
    backdropFilter: 'blur(12px)',
    webkitBackdropFilter: 'blur(12px)',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    borderRadius: '8px',
    boxShadow: '0 6px 32px rgba(0, 0, 0, 0.45)',
    color: '#ddd',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.75rem',
    pointerEvents: 'auto',
    minWidth: '260px',
    maxWidth: '320px',
  })
}

function buildPanelHtml(): string {
  const s = getShaderSettings()
  const sliders = ROWS.map((row) => {
    const band = TUNER_BANDS[row.key]
    const v = s[row.key]
    return `
      <div class="shader-tuner-row" style="display:grid;grid-template-columns:64px 1fr 48px;gap:0.4rem;align-items:center;margin-block-end:0.35rem;">
        <label for="shader-tuner-${row.shortKey}" style="color:#bbb;">${escape(row.label)}</label>
        <input type="range" id="shader-tuner-${row.shortKey}" data-key="${row.key}"
          min="${band.min}" max="${band.max}" step="${band.step}" value="${v}"
          style="accent-color:#4da6ff;"/>
        <span class="shader-tuner-value" data-key="${row.key}" style="color:#fff;text-align:right;font-variant-numeric:tabular-nums;">${v.toFixed(2)}</span>
      </div>
    `
  }).join('')
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-block-end:0.5rem;padding-block-end:0.35rem;border-block-end:1px solid rgba(255,255,255,0.08);">
      <strong style="font-weight:600;letter-spacing:0.06em;text-transform:uppercase;font-size:0.7rem;color:#bbb;">Shader Tuner</strong>
      <button type="button" id="shader-tuner-close" aria-label="Close tuner"
        style="background:transparent;border:none;color:#999;cursor:pointer;font-size:0.9rem;padding:0;line-height:1;">&#x2715;</button>
    </div>
    ${sliders}
    <div style="display:flex;gap:0.4rem;margin-block-start:0.6rem;">
      <button type="button" id="shader-tuner-reset"
        style="flex:1;padding:0.35rem 0.4rem;font:inherit;font-size:0.7rem;color:#ccc;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.10);border-radius:4px;cursor:pointer;">Reset to shipped</button>
      <button type="button" id="shader-tuner-copy"
        style="flex:1;padding:0.35rem 0.4rem;font:inherit;font-size:0.7rem;color:#4da6ff;background:rgba(77,166,255,0.08);border:1px solid rgba(77,166,255,0.35);border-radius:4px;cursor:pointer;">Copy as defaults</button>
    </div>
    <p style="margin:0.5rem 0 0;font-size:0.65rem;color:#888;line-height:1.3;">Dev-only. Drag sliders to tune; paste the &quot;Copy&quot; output into SHADER_DEFAULTS.</p>
  `
}

function wireSliders(host: HTMLElement): void {
  const inputs = host.querySelectorAll<HTMLInputElement>('input[type="range"]')
  inputs.forEach((input) => {
    input.addEventListener('input', () => {
      const key = input.dataset.key as keyof ShaderSettings
      const value = Number(input.value)
      setTunerValue(key, value)
      const display = host.querySelector<HTMLSpanElement>(
        `.shader-tuner-value[data-key="${key}"]`,
      )
      if (display) display.textContent = value.toFixed(2)
    })
  })
}

function wireCopyButton(host: HTMLElement): void {
  const btn = host.querySelector<HTMLButtonElement>('#shader-tuner-copy')
  if (!btn) return
  btn.addEventListener('click', async () => {
    const s = getShaderSettings()
    const json = ROWS.map((row) => `  ${row.shortKey}: ${s[row.key].toFixed(2)},`).join('\n')
    const snippet = `export const SHADER_DEFAULTS = {\n${json}\n} as const`
    try {
      await navigator.clipboard.writeText(snippet)
      btn.textContent = 'Copied!' // i18n-exempt: dev-tuner transient state
      window.setTimeout(() => { btn.textContent = 'Copy as defaults' /* i18n-exempt: dev-tuner label */ }, 1200)
    } catch (err) {
      logger.warn('[shaderTuner] clipboard write failed', err)
      btn.textContent = 'Copy failed' // i18n-exempt: dev-tuner transient state
      window.setTimeout(() => { btn.textContent = 'Copy as defaults' /* i18n-exempt: dev-tuner label */ }, 1600)
    }
  })
}

function wireResetButton(host: HTMLElement): void {
  const btn = host.querySelector<HTMLButtonElement>('#shader-tuner-reset')
  if (!btn) return
  btn.addEventListener('click', () => {
    for (const row of ROWS) {
      setTunerValue(row.key, SHADER_DEFAULTS[row.key])
    }
    syncSliders(host, getShaderSettings())
  })
}

function wireCloseButton(host: HTMLElement, unsubscribe: () => void): void {
  const btn = host.querySelector<HTMLButtonElement>('#shader-tuner-close')
  if (!btn) return
  btn.addEventListener('click', () => {
    unsubscribe()
    host.remove()
  })
}

/**
 * Push the current settings snapshot into every slider + value
 * label. Used when external code (Tools menu, reset) writes to the
 * settings service.
 */
function syncSliders(host: HTMLElement, s: ShaderSettings): void {
  for (const row of ROWS) {
    const input = host.querySelector<HTMLInputElement>(
      `input[data-key="${row.key}"]`,
    )
    if (input) input.value = String(s[row.key])
    const display = host.querySelector<HTMLSpanElement>(
      `.shader-tuner-value[data-key="${row.key}"]`,
    )
    if (display) display.textContent = s[row.key].toFixed(2)
  }
}

/** Minimal HTML-escape — labels are constants in this file but
 *  guarding against a typo introducing `<` keeps the injection
 *  surface zero. */
function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
