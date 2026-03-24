/**
 * Cloudflare Pages Function — /api/models
 *
 * Health-check endpoint for the "Test Connection" button.
 * Returns a minimal OpenAI-compatible model list.
 */

interface Env {
  AI: unknown
}

function getAllowedOrigin(origin: string | null, requestUrl: string): string | null {
  if (!origin) return null
  const devOrigins = new Set(['http://localhost:5173', 'http://localhost:4173'])
  if (devOrigins.has(origin)) return origin
  try {
    const req = new URL(requestUrl)
    if (origin === req.origin) return origin
  } catch { /* ignore */ }
  return null
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const origin = context.request.headers.get('Origin')
  const allowed = getAllowedOrigin(origin, context.request.url)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (allowed) {
    headers['Access-Control-Allow-Origin'] = allowed
    headers['Vary'] = 'Origin'
  }

  return new Response(
    JSON.stringify({
      object: 'list',
      data: [
        {
          id: '@cf/meta/llama-3.1-8b-instruct',
          object: 'model',
          owned_by: 'cloudflare',
        },
        {
          id: '@cf/meta/llama-3.2-3b-instruct',
          object: 'model',
          owned_by: 'cloudflare',
        },
      ],
    }),
    { headers },
  )
}
