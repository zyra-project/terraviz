/**
 * Fetch a URL as a Blob with byte-level progress reporting.
 * Falls back to a plain fetch if the response has no Content-Length or ReadableStream.
 */
export async function fetchWithProgress(
  url: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<Blob> {
  const response = await fetch(url)
  const contentLength = Number(response.headers.get('content-length') || 0)

  if (!response.body || !contentLength) {
    // No streaming support or unknown size — fetch without progress
    return response.blob()
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    onProgress?.(received, contentLength)
  }

  return new Blob(chunks as BlobPart[])
}

/**
 * Load an image via fetch with progress, returning an HTMLImageElement.
 */
export async function fetchImageWithProgress(
  url: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<HTMLImageElement> {
  const blob = await fetchWithProgress(url, onProgress)
  const objectUrl = URL.createObjectURL(blob)
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error(`Failed to decode image: ${url}`))
    }
    img.src = objectUrl
  })
}
