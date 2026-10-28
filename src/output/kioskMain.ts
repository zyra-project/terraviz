// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Entry point of the exhibit's kiosk page, `/output/kiosk`
 * (docs/SECOND_LIFE_COMPAT.md §7 item 9; its address is in
 * docs/EMBED_URL_GRAMMAR.md). Thin on purpose, as `orbitMain.ts` is:
 * it reads the address with the globe page's own reader, so the two
 * pages can't read one clock differently, and hands each reading to
 * `kioskPage`, where the ordering lives.
 *
 * No WebGL, no video and no telemetry: a visitor's viewer runs only a
 * few web pages at full priority, and the kiosk should cost them little
 * when it is one of them.
 */
import '../styles/tokens.css'
import '../styles/colorbar.css'
import '../styles/kiosk.css'
import { bootstrapI18n } from '../i18n/bootstrap'
import { mountKiosk } from '../ui/kioskUI'
import { logger } from '../utils/logger'
import { fetchKioskDataset } from './kioskModel'
import { createKioskPage } from './kioskPage'
import { readWebSettings } from './webMode'

/** How often the date is worked out again. The words change only when
 *  the globe steps a frame, and the screen is touched only then. */
const KIOSK_TICK_MS = 250

async function boot(): Promise<void> {
  await bootstrapI18n()
  const root = document.getElementById('kiosk')
  if (!root) return
  const screen = mountKiosk(root)
  const page = createKioskPage({
    screen,
    fetchDataset: (id) => fetchKioskDataset(id, { base: window.location.href }),
    log: (message) => logger.warn(message),
  })
  // Listening first, then reading: a `#` change in between is read
  // either way.
  const read = (): void => page.apply(readWebSettings(window.location.search, window.location.hash))
  window.addEventListener('hashchange', read)
  window.addEventListener('resize', () => screen.fit())
  read()
  setInterval(() => page.tick(), KIOSK_TICK_MS)
}

void boot()
