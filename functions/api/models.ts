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

  // Verify the AI binding is available — if not, the endpoint is misconfigured
  if (!context.env.AI) {
    return new Response(
      JSON.stringify({ error: 'AI binding not configured' }),
      { status: 503, headers: { ...headers, 'Content-Type': 'application/json' } },
    )
  }

  // Keep this list in sync with MODEL_MAP in functions/api/chat/completions.ts.
  // The client sorts models alphabetically before displaying in the picker.
  return new Response(
    JSON.stringify({
      object: 'list',
      data: [
        { id: 'llama-4-scout', object: 'model', owned_by: 'cloudflare' },
        { id: 'llama-3.3-70b', object: 'model', owned_by: 'cloudflare' },
        { id: 'llama-3.1-70b', object: 'model', owned_by: 'cloudflare' },
        { id: 'llama-3.1-8b', object: 'model', owned_by: 'cloudflare' },
        { id: 'llama-3.2-3b', object: 'model', owned_by: 'cloudflare' },
        { id: 'llama-3.2-11b-vision', object: 'model', owned_by: 'cloudflare' },
      ],
    }),
    { headers },
  )
}
