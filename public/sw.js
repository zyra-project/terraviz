// Service Worker — cache-first strategy for static GIBS tiles and textures.
// These assets never change (Blue Marble 2004, Black Marble 2016), so we cache
// indefinitely and serve from cache on every subsequent request.

const CACHE_NAME = 'gibs-tiles-v1'

// External URLs to cache — scoped to specific paths, not entire hostnames
const CACHEABLE_EXTERNAL = [
  { hostname: 'gibs.earthdata.nasa.gov', pathPrefix: '/wmts/epsg3857/best/' },
  { hostname: 's3.dualstack.us-east-1.amazonaws.com', pathPrefix: '/metadata.sosexplorer.gov/' },
]

// Same-origin paths to cache (proxied tiles, skybox, specular map, etc.)
// These are static textures that rarely change. If they do, bump CACHE_NAME above.
const CACHEABLE_LOCAL_PATHS = [
  '/api/tile/',
  '/assets/skybox/',
  '/assets/Earth_Specular_2K.jpg',
  '/assets/Earth_Normal_2K.jpg',
]

function shouldCache(url) {
  const parsed = new URL(url)

  // Match external cacheable origins + path prefixes
  if (CACHEABLE_EXTERNAL.some(
    rule => parsed.hostname === rule.hostname && parsed.pathname.startsWith(rule.pathPrefix)
  )) {
    return true
  }

  // Match local asset paths
  if (parsed.origin === self.location.origin &&
      CACHEABLE_LOCAL_PATHS.some(p => parsed.pathname.startsWith(p))) {
    return true
  }

  return false
}

self.addEventListener('install', event => {
  // Activate immediately without waiting for existing clients to close
  self.skipWaiting()
  event.waitUntil(caches.open(CACHE_NAME))
})

self.addEventListener('activate', event => {
  // Claim all open clients so the SW starts intercepting immediately
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // Clean up any old cache versions
      caches.keys().then(names =>
        Promise.all(
          names
            .filter(name => name !== CACHE_NAME)
            .map(name => caches.delete(name))
        )
      ),
    ])
  )
})

self.addEventListener('fetch', event => {
  const { request } = event

  // Only intercept GET requests for cacheable URLs
  if (request.method !== 'GET' || !shouldCache(request.url)) {
    return
  }

  event.respondWith(
    (async () => {
      let cache
      try {
        cache = await caches.open(CACHE_NAME)
      } catch {
        // Cache API unavailable — let the browser handle the request normally
        return fetch(request.clone())
      }

      // Cache-first: serve from cache if available
      const cached = await cache.match(request)
      if (cached) {
        return cached
      }

      // Not cached — fetch from network, cache the response, return it
      const response = await fetch(request.clone())

      if (response.ok) {
        try {
          await cache.put(request, response.clone())
        } catch {
          // Cache write failed (e.g. quota exceeded) — still return the response
        }
      }

      return response
    })()
  )
})
