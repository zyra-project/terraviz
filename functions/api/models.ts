/**
 * Cloudflare Pages Function — /api/models
 *
 * Health-check endpoint for the "Test Connection" button.
 * Returns a minimal OpenAI-compatible model list.
 */

interface Env {
  AI: unknown
}

export const onRequestGet: PagesFunction<Env> = async () => {
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
    {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    },
  )
}
