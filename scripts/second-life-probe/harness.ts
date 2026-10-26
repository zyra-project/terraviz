// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Runs the probe page through every mode in headless Chromium, against a
 * local stand-in for the script's HTTP-in endpoint, before anyone takes
 * it in-world.
 *
 * The stand-in does what `terraviz-probe.lsl` does: serves the page for
 * a GET to `/` with any query, answers anything else 404 (a browser asks
 * for `/favicon.ico`), and splits each POST on `~` into lines the way
 * the script says them in chat. It also refuses a POST body over 2 KB,
 * the HTTP-in cap, which would otherwise arrive cut off mid-line
 * in-world. The page served is the one reassembled from the *generated
 * script*, not `probe.html`, so what passes here is what the script
 * would serve.
 *
 * Each mode runs until it reports its **last** line — the end of the
 * video fallback chain, the probe's playback test, the third heartbeat —
 * or a deadline passes, so a run that stops partway fails rather than
 * passing on its opening lines.
 *
 * What it proves is that the page is sound: it runs, reports in every
 * mode, and takes its fallbacks. It proves nothing about Second Life's
 * embedded browser — headless Chromium is a newer browser with different
 * codecs — which is what the in-world run is for. So whether a video
 * *played* is printed, not judged; whether the chain reached its end is.
 * The one exception is the `#` run, whose question is whether a change
 * after `#` disturbs a playing video: it waits for one to play, and
 * fails if the video isn't still playing when the page reports.
 *
 * `PLAYWRIGHT_CHROMIUM_PATH` picks the browser, the convention
 * `scripts/screenshots/core/browser.ts` uses, and `HTTPS_PROXY` is
 * honoured for the page's own fetches. The image and video modes need
 * the network.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeFileSync } from 'node:fs'
import { chromium, type Browser } from 'playwright'

/** The media size the probe asks Second Life for. */
const VIEWPORT = { width: 2048, height: 1024 }

/** What HTTP-in accepts in a request body. */
const MAX_POST_BYTES = 2048

const HEARTBEAT = /^soak [\w ]+: \d+s, /

interface ModeRun {
  query: string
  label: string
  /** Hide native HLS, to take the path Second Life's browser takes. */
  noNativeHls?: boolean
  /** Lines the run must produce, by prefix or by pattern. */
  expect: (string | RegExp)[]
  /** The run is over when this holds. */
  done: (lines: string[]) => boolean
  /** Lines that mean the run reached its end and failed. */
  fails?: string[]
  /** Once this holds, change only the address's # part, as `/7 hash` does. */
  hashAfter?: (lines: string[]) => boolean
  /** For the whole run, the # change included. */
  deadlineMs: number
}

/** How long a run is watched after its last report, for a late reload. */
const SETTLE_MS = 3000

const has = (match: string | RegExp) => (lines: string[]) =>
  lines.some((l) => (typeof match === 'string' ? l.startsWith(match) : match.test(l)))
const loads = (lines: string[]) => lines.filter((l) => l.startsWith('mode: ')).length
const anyOf = (...prefixes: string[]) => (lines: string[]) => prefixes.some((p) => has(p)(lines))
const beats = (lines: string[]) => lines.filter((l) => HEARTBEAT.test(l)).length

/** The last stage a video run can report from, however it got there. */
const VIDEO_END = ['TerraViz stream, native HLS: PLAYING', 'TerraViz stream via hls.js: PLAYING', 'test stream via hls.js']

const RUNS: ModeRun[] = [
  {
    query: 'probe', label: 'probe', deadlineMs: 60_000,
    expect: ['mode: probe', 'chrome:', 'WebGL 2:', 'webgl frames:'],
    done: anyOf('hls.js test stream:', 'hls.js: could not load'),
  },
  {
    query: 'image', label: 'image', deadlineMs: 30_000,
    expect: ['mode: image'],
    done: has('TerraViz image:'), fails: ['TerraViz image: failed'],
  },
  {
    query: 'video', label: 'video', deadlineMs: 75_000,
    expect: ['mode: video'],
    done: anyOf(...VIDEO_END, 'hls.js: could not load'),
  },
  {
    query: 'video', label: 'video, native HLS hidden', noNativeHls: true, deadlineMs: 75_000,
    expect: ['mode: video', 'native HLS: no'],
    done: anyOf(...VIDEO_END.slice(1), 'hls.js: could not load'),
  },
  {
    // Only once a stream is playing, so the report says whether the
    // change disturbed it.
    query: 'video', label: 'hash, mid-video', noNativeHls: true, deadlineMs: 90_000,
    expect: ['mode: video', /^hash: #h=1, video t=[\d.]+s, playing, readyState [34]$/],
    hashAfter: anyOf('TerraViz stream via hls.js: PLAYING', 'test stream via hls.js (not TerraViz data): PLAYING'),
    done: has('hash:'),
  },
  {
    query: 'soak', label: 'soak', deadlineMs: 45_000,
    expect: ['mode: soak webgl'], done: (lines) => beats(lines) >= 3,
  },
  {
    query: 'soak2d', label: 'soak2d', deadlineMs: 45_000,
    expect: ['mode: soak 2d'], done: (lines) => beats(lines) >= 3,
  },
]

function launch(): Promise<Browser> {
  const proxy = process.env.HTTPS_PROXY
  return chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH?.trim() || undefined,
    proxy: proxy ? { server: proxy, bypass: '127.0.0.1,localhost' } : undefined,
  })
}

/** The script's HTTP-in endpoint, as far as the page can tell. */
function standIn(page: string, lines: string[], problems: string[]): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET') {
      if (path !== '/') { res.writeHead(404).end(); return }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page)
      return
    }
    if (req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        if (body.length > MAX_POST_BYTES) problems.push(`a ${body.length}-byte report, over the ${MAX_POST_BYTES}-byte HTTP-in cap`)
        lines.push(...body.toString('utf8').split('~'))
        res.writeHead(200).end('ok')
      })
      return
    }
    res.writeHead(405).end()
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/** Waits for `done` to hold, or for the clock to pass `end`; says which. */
async function until(done: () => boolean, end: number): Promise<boolean> {
  while (!done()) {
    if (Date.now() > end) return false
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return true
}

/** Runs every mode (or those whose label starts with `only`); true if all passed. */
export async function testPage(page: string, only?: string): Promise<boolean> {
  const lines: string[] = []
  const problems: string[] = []
  const server = await standIn(page, lines, problems)
  const { port } = server.address() as AddressInfo
  const browser = await launch()
  let allPassed = true
  try {
    for (const run of RUNS.filter((r) => !only || r.label.startsWith(only))) {
      lines.length = 0
      problems.length = 0
      const tab = await browser.newPage({ viewport: VIEWPORT })
      tab.on('pageerror', (e) => problems.push(`page error: ${e.message}`))
      if (run.noNativeHls) {
        await tab.addInitScript(() => {
          const original = HTMLMediaElement.prototype.canPlayType
          HTMLMediaElement.prototype.canPlayType = function (type: string) {
            return /mpegurl/i.test(type) ? '' : original.call(this, type)
          }
        })
      }
      const url = `http://127.0.0.1:${port}/?${run.query}&n=1`
      const end = Date.now() + run.deadlineMs
      // Counted from the browser's side as well as the page's: a reload
      // that never reports, because it failed or went somewhere else,
      // shows up only here. A change to the # alone requests nothing.
      let documents = 0
      tab.on('request', (r) => { if (r.isNavigationRequest() && r.frame() === tab.mainFrame()) documents++ })
      // Each page reports its mode once per load, so a second is a reload,
      // and the run stops there rather than waiting out its deadline.
      const reloaded = () => loads(lines) > 1 || documents > 1
      await tab.goto(url)
      const hashAfter = run.hashAfter
      if (hashAfter && await until(() => hashAfter(lines) || reloaded(), end) && !reloaded()) await tab.goto(`${url}#h=1`)
      const finished = await until(() => run.done(lines) || reloaded(), end) && !reloaded()
      // A reload just after the last report would otherwise pass.
      if (finished) await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
      await tab.close()

      if (!finished && !reloaded()) problems.push(`did not reach its last report within ${run.deadlineMs / 1000} s`)
      if (loads(lines) !== 1) problems.push(`the page loaded ${loads(lines)} times`)
      if (documents !== 1) problems.push(`the browser requested the page ${documents} times`)
      for (const match of run.expect) if (!has(match)(lines)) problems.push(`no "${match}" line`)
      for (const prefix of run.fails ?? []) if (has(prefix)(lines)) problems.push(`reported "${prefix}"`)

      console.log(`\n=== ${run.label}: ${problems.length === 0 ? 'ok' : 'FAILED'}`)
      for (const line of lines) console.log(`  [page] ${line}`)
      for (const problem of problems) console.log(`  !! ${problem}`)
      if (problems.length > 0) allPassed = false
    }
  } finally {
    await browser.close()
    server.close()
  }
  return allPassed
}

/**
 * Writes the probe's labelled grid as a PNG, for the local-texture test
 * (an ordinary texture on a second sphere, beside the shared-media one).
 * Drawn by the page's own code, so the lines and colours match the
 * shared-media sphere exactly; the labels may render in a different font
 * than the viewer's browser uses.
 */
export async function renderGrid(page: string, out: string): Promise<void> {
  const browser = await launch()
  try {
    const tab = await browser.newPage({ viewport: VIEWPORT })
    await tab.setContent(page)
    const url = await tab.evaluate(() => (document.getElementById('g') as HTMLCanvasElement).toDataURL('image/png'))
    writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'))
  } finally {
    await browser.close()
  }
}
