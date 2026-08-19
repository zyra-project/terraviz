/** Safe, cache-first readers and path resolution for native SOS playlists. */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const WINDOWS_ABSOLUTE = /^[a-z]:[\\/]/i

export interface SosPlaylistReaderOptions {
  cacheDir?: string
  maxBytes?: number
  timeoutMs?: number
  refresh?: boolean
  allowNetwork?: boolean
}

export type SosPlaylistReader = (source: string) => Promise<string>

export function sosPathToFtpUrl(value: string): string | null {
  const normalized = value.replace(/\\/g, '/')
  const mediaPrefix = '/shared/sos/media/'
  if (normalized.startsWith(mediaPrefix)) {
    return `ftp://public.sos.noaa.gov/${normalized.slice(mediaPrefix.length)}`
  }
  const realtimePrefix = '/shared/sos/rt/noaa/'
  if (normalized.startsWith(realtimePrefix)) {
    return `ftp://public.sos.noaa.gov/rt/${normalized.slice(realtimePrefix.length)}`
  }
  return null
}

/** Resolve an SOS path relative to the playlist containing it. */
export function resolveSosReference(base: string, value: string): string {
  const mapped = sosPathToFtpUrl(value)
  if (mapped) return mapped
  if (URL_SCHEME.test(value) && !WINDOWS_ABSOLUTE.test(value)) return value

  if (URL_SCHEME.test(base) && !WINDOWS_ABSOLUTE.test(base)) {
    return new URL(value.replace(/\\/g, '/'), base).toString()
  }
  if (isAbsolute(value)) return resolve(value)
  return resolve(dirname(base), value)
}

function cachePath(cacheDir: string, source: string): string {
  const digest = createHash('sha256').update(source).digest('hex')
  return resolve(cacheDir, `${digest}.sos`)
}

function enforceSize(source: string, bytes: number, maxBytes: number): void {
  if (bytes > maxBytes) {
    throw new Error(`${source} is ${bytes} bytes; playlist limit is ${maxBytes}`)
  }
}

async function readHttp(source: string, maxBytes: number, timeoutMs: number): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(source, {
      signal: controller.signal,
      headers: { 'User-Agent': 'TerraViz-SOS-Importer/1.0' },
      redirect: 'follow',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared) enforceSize(source, declared, maxBytes)
    const bytes = new Uint8Array(await response.arrayBuffer())
    enforceSize(source, bytes.byteLength, maxBytes)
    return new TextDecoder().decode(bytes)
  } finally {
    clearTimeout(timer)
  }
}

function readFtpWithCurl(source: string, maxBytes: number, timeoutMs: number): Promise<string> {
  return new Promise((resolveText, reject) => {
    const args = [
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--max-time',
      String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      '--max-filesize',
      String(maxBytes),
      '--url',
      source,
    ]
    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    const chunks: Buffer[] = []
    let bytes = 0
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        child.kill()
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', chunk => (stderr += String(chunk)))
    child.on('error', error => reject(new Error(`could not start curl: ${error.message}`)))
    child.on('close', code => {
      if (bytes > maxBytes) {
        reject(new Error(`${source} exceeded playlist limit ${maxBytes}`))
      } else if (code !== 0) {
        reject(new Error(`FTP fetch failed (${code}): ${stderr.trim() || source}`))
      } else {
        resolveText(Buffer.concat(chunks).toString('utf8'))
      }
    })
  })
}

export function createSosPlaylistReader(
  options: SosPlaylistReaderOptions = {},
): SosPlaylistReader {
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024
  const timeoutMs = options.timeoutMs ?? 30_000
  const allowNetwork = options.allowNetwork ?? true

  return async source => {
    const protocol = WINDOWS_ABSOLUTE.test(source)
      ? undefined
      : URL_SCHEME.exec(source)?.[0].toLowerCase()
    const localPath = protocol === 'file:' ? fileURLToPath(source) : protocol ? null : source
    if (localPath) {
      const size = statSync(localPath).size
      enforceSize(source, size, maxBytes)
      return readFileSync(localPath, 'utf8')
    }

    const cached = options.cacheDir ? cachePath(options.cacheDir, source) : undefined
    if (cached && !options.refresh) {
      try {
        return readFileSync(cached, 'utf8')
      } catch {
        // Cache miss; fetch below.
      }
    }
    if (!allowNetwork) throw new Error(`network disabled and no cached copy exists for ${source}`)

    let text: string
    if (protocol === 'http:' || protocol === 'https:') {
      text = await readHttp(source, maxBytes, timeoutMs)
    } else if (protocol === 'ftp:') {
      text = await readFtpWithCurl(source, maxBytes, timeoutMs)
    } else {
      throw new Error(`unsupported playlist protocol in ${source}`)
    }

    if (cached) {
      mkdirSync(dirname(cached), { recursive: true })
      writeFileSync(cached, text, 'utf8')
      writeFileSync(`${cached}.source`, `${source}\n`, 'utf8')
    }
    return text
  }
}

export function asFileUrl(path: string): string {
  return pathToFileURL(resolve(path)).toString()
}
