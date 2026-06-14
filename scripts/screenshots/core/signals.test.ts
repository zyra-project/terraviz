import { describe, expect, it } from 'vitest'

import {
  axeEnabled,
  createSignalCollector,
  type ConsoleMessageLike,
  type RequestLike,
  type ResponseLike,
} from './signals'

const consoleMsg = (type: string, text: string): ConsoleMessageLike => ({
  type: () => type,
  text: () => text,
})

const request = (
  url: string,
  method: string,
  errorText: string | null,
): RequestLike => ({
  url: () => url,
  method: () => method,
  failure: () => (errorText === null ? null : { errorText }),
})

const response = (url: string, status: number): ResponseLike => ({
  url: () => url,
  status: () => status,
})

describe('createSignalCollector', () => {
  it('buckets console errors and warnings, ignoring other levels', () => {
    const c = createSignalCollector()
    c.handleConsole(consoleMsg('error', 'boom'))
    c.handleConsole(consoleMsg('warning', 'heads up'))
    c.handleConsole(consoleMsg('log', 'noise'))
    c.handleConsole(consoleMsg('info', 'noise'))

    expect(c.signals.consoleErrors).toEqual(['boom'])
    expect(c.signals.consoleWarnings).toEqual(['heads up'])
  })

  it('records page errors by message', () => {
    const c = createSignalCollector()
    c.handlePageError(new Error('uncaught'))
    expect(c.signals.pageErrors).toEqual(['uncaught'])
  })

  it('records failed requests with a fallback failure text', () => {
    const c = createSignalCollector()
    c.handleRequestFailed(request('https://x/img.png', 'GET', 'net::ERR_FAILED'))
    c.handleRequestFailed(request('https://x/late', 'POST', null))

    expect(c.signals.failedRequests).toEqual([
      { url: 'https://x/img.png', method: 'GET', failure: 'net::ERR_FAILED' },
      { url: 'https://x/late', method: 'POST', failure: 'unknown' },
    ])
  })

  it('records only 4xx/5xx responses as bad', () => {
    const c = createSignalCollector()
    c.handleResponse(response('https://x/ok', 200))
    c.handleResponse(response('https://x/redirect', 302))
    c.handleResponse(response('https://x/missing', 404))
    c.handleResponse(response('https://x/boom', 500))

    expect(c.signals.badResponses).toEqual([
      { url: 'https://x/missing', status: 404 },
      { url: 'https://x/boom', status: 500 },
    ])
  })

  it('starts with no axe violations until a scan populates them', () => {
    const c = createSignalCollector()
    expect(c.signals.axeViolations).toBeUndefined()
  })
})

describe('axeEnabled', () => {
  const orig = process.env.VISUAL_AXE
  const restore = () => {
    if (orig === undefined) delete process.env.VISUAL_AXE
    else process.env.VISUAL_AXE = orig
  }

  it('is true for "1" or "true", false otherwise', () => {
    process.env.VISUAL_AXE = '1'
    expect(axeEnabled()).toBe(true)
    process.env.VISUAL_AXE = 'true'
    expect(axeEnabled()).toBe(true)
    process.env.VISUAL_AXE = 'false'
    expect(axeEnabled()).toBe(false)
    delete process.env.VISUAL_AXE
    expect(axeEnabled()).toBe(false)
    restore()
  })
})
