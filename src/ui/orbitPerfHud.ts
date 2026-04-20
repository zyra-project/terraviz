/**
 * Perf HUD for the Orbit standalone page.
 *
 * Small unobtrusive overlay showing FPS (rolling 1 s average), JS
 * heap size (Chromium only via non-standard `performance.memory`),
 * and uptime (time since the HUD started). Added so long-session
 * drift — the user observed ~1 FPS after leaving the page running
 * overnight — can be confirmed with real data rather than inferred.
 *
 * The HUD runs its own requestAnimationFrame loop so frame counts
 * stay accurate even when the OrbitController's render loop is
 * throttled by the browser. DOM writes happen at most once per
 * second.
 */

export interface PerfHudHandle {
  dispose(): void
}

/**
 * Chromium exposes a non-standard `performance.memory` with
 * `usedJSHeapSize`; Firefox and Safari don't. Type it ourselves so
 * the build doesn't require DOM libs that include the extension.
 */
interface PerformanceMemory {
  readonly usedJSHeapSize: number
}
interface PerformanceWithMemory extends Performance {
  readonly memory?: PerformanceMemory
}

export function initOrbitPerfHud(element: HTMLElement): PerfHudHandle {
  let frameCount = 0
  let lastSampleMs = performance.now()
  const startMs = lastSampleMs
  let rafId = 0
  let disposed = false

  const sample = (): void => {
    if (disposed) return
    rafId = requestAnimationFrame(sample)
    frameCount++
    const now = performance.now()
    const elapsed = now - lastSampleMs
    if (elapsed < 1000) return
    const fps = Math.round((frameCount / elapsed) * 1000)
    const heap = formatHeap()
    const uptime = formatUptime(now - startMs)
    element.textContent = `${fps} FPS  •  ${heap}  •  ${uptime}`
    frameCount = 0
    lastSampleMs = now
  }

  // Seed the text before the first 1 s window elapses so the HUD
  // doesn't render blank for the first second after page load.
  element.textContent = '— FPS  •  —  •  0:00:00'
  rafId = requestAnimationFrame(sample)

  return {
    dispose(): void {
      disposed = true
      cancelAnimationFrame(rafId)
    },
  }
}

function formatHeap(): string {
  const perf = performance as PerformanceWithMemory
  const used = perf.memory?.usedJSHeapSize
  if (typeof used !== 'number') return '—'
  return `${(used / 1024 / 1024).toFixed(1)} MB`
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}
