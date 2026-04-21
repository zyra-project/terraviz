/**
 * In-VR dataset browse panel — a floating CanvasTexture panel that
 * renders the dataset catalog so the user can switch datasets
 * without exiting the XR session.
 *
 * The panel mirrors a simplified version of the 2D `browseUI.ts`:
 * scrollable list of dataset cards with title and category, tappable
 * via controller raycast. A chip row above the list filters by
 * category (per the Phase 3 plan, favoring chips over a virtual-
 * keyboard search for v1).
 *
 * Same CanvasTexture + UV hit-test pattern as `vrHud.ts`. The caller
 * (`vrSession.ts`) adds the mesh to the scene, toggles visibility,
 * and calls `dispose()` on session end.
 *
 * See {@link file://./../../docs/VR_INVESTIGATION_PLAN.md VR_INVESTIGATION_PLAN.md}
 * Phase 3 section.
 */

import type * as THREE from 'three'
import type { VrDatasetEntry } from './vrSession'

/** World-space size of the browse panel. */
const PANEL_WIDTH = 0.8
const PANEL_HEIGHT = 0.6

/** Canvas resolution. 4:3 ratio matches the 0.8 × 0.6 m panel. */
const CANVAS_WIDTH = 800
const CANVAS_HEIGHT = 600

/** Visual constants. */
const BG_COLOR = 'rgba(13, 13, 18, 0.92)'
const BORDER_COLOR = 'rgba(255, 255, 255, 0.12)'
const TITLE_COLOR = '#e8eaf0'
const SUBTITLE_COLOR = 'rgba(232, 234, 240, 0.5)'
const ACCENT_COLOR = 'rgba(77, 166, 255, 0.9)'
const CARD_BG = 'rgba(255, 255, 255, 0.06)'
const CARD_BG_HOVER = 'rgba(77, 166, 255, 0.15)'

const TITLE_BAR_HEIGHT = 60
const CHIP_ROW_HEIGHT = 48
const CHIP_HEIGHT = 32
const CHIP_PADDING_X = 14
const CHIP_GAP = 8
const CHIP_MARGIN_X = 12
const CHIP_VERTICAL_OFFSET = (CHIP_ROW_HEIGHT - CHIP_HEIGHT) / 2
const CARD_HEIGHT = 72
const CARD_GAP = 4
const CARD_PADDING_X = 14
const THUMB_SIZE = CARD_HEIGHT - 12 // square thumb, 6-px top+bottom inset
const THUMB_MARGIN_RIGHT = 12
const LIST_PADDING = 12
const SCROLLBAR_WIDTH = 8

export interface VrBrowseHandle {
  readonly mesh: THREE.Mesh
  setVisible(visible: boolean): void
  isVisible(): boolean
  /** Provide the dataset catalog. Triggers a redraw. */
  setDatasets(datasets: VrDatasetEntry[]): void
  /**
   * Set the active category filter. Pass `null` to clear the
   * filter and show the full catalog. Resets scroll position to the
   * top so the first filtered result is always in view.
   */
  setCategoryFilter(category: string | null): void
  /** Scroll the list by a delta (positive = down). Called per-frame from vrInteraction. */
  scroll(delta: number): void
  hitTest(uv: { x: number; y: number }): VrBrowseAction | null
  dispose(): void
}

export type VrBrowseAction =
  | { kind: 'close' }
  | { kind: 'select'; datasetId: string }
  /**
   * Tapped a chip in the category row. `category === null` means the
   * user tapped the dedicated "All" chip — caller clears the filter.
   * Otherwise filter the list to `category`; tapping an already-
   * selected specific-category chip is a no-op re-send (the caller
   * reapplies the same filter), not a toggle-off.
   */
  | { kind: 'category'; category: string | null }

/**
 * Content area = everything below the title bar + chip row.
 * The chip row sits between the title bar and the list so all three
 * regions stack top→bottom: title, chips, list, (scrollbar overlays
 * the list at the right edge).
 */
const CHIP_ROW_TOP = TITLE_BAR_HEIGHT
const CHIP_ROW_BOTTOM = CHIP_ROW_TOP + CHIP_ROW_HEIGHT
const LIST_TOP = CHIP_ROW_BOTTOM + LIST_PADDING
const LIST_BOTTOM = CANVAS_HEIGHT - LIST_PADDING
const LIST_HEIGHT = LIST_BOTTOM - LIST_TOP

const CLOSE_BUTTON = {
  uMin: (CANVAS_WIDTH - 50) / CANVAS_WIDTH,
  uMax: 1.0,
  vMin: 1 - TITLE_BAR_HEIGHT / CANVAS_HEIGHT,
  vMax: 1.0,
}

/**
 * Draw a filled rounded rectangle, falling back to a plain rect on
 * browsers / WebViews whose Canvas 2D context doesn't expose
 * `roundRect` (pre-Chromium-99, older Quest Browser builds, some
 * embedded WebViews). Matches the pattern used in vrInteraction.ts
 * for the controller tooltip. Caller sets `fillStyle` beforehand.
 */
function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, r)
    ctx.fill()
  } else {
    ctx.fillRect(x, y, w, h)
  }
}

/**
 * One rendered chip's pixel rect. Precomputed each layout pass so
 * the draw loop and the hit-test loop agree byte-for-byte on where
 * each chip lives.
 */
interface ChipRect {
  /** Filter this chip applies when tapped. null = the "All" chip (clears the filter). */
  category: string | null
  /** Text rendered on the pill — "All" for the reset chip, else the category name. */
  label: string
  x: number
  y: number
  width: number
  height: number
}

/**
 * Compute the list of chips to render based on the current dataset
 * catalog + selected filter. Used by both drawCanvas (to paint) and
 * hitTest (to resolve taps). Keeping both paths on the same layout
 * function means they can't disagree about where each chip lives.
 *
 * Canvas text-measurement needs a context, so layoutChips accepts
 * one; both call sites already have one handy.
 */
function layoutChips(
  ctx: CanvasRenderingContext2D,
  categories: string[],
): ChipRect[] {
  const chips: ChipRect[] = []
  ctx.save()
  ctx.font = '500 15px system-ui, -apple-system, sans-serif'

  let x = CHIP_MARGIN_X
  const y = CHIP_ROW_TOP + CHIP_VERTICAL_OFFSET

  // "All" chip always leads the row — gives the user a clear way
  // out of any filter without having to discover the "tap the
  // active chip again to clear" trick. Its `category: null` maps
  // directly to setCategoryFilter(null).
  const allMetrics = ctx.measureText('All')
  const allWidth = allMetrics.width + CHIP_PADDING_X * 2
  chips.push({
    category: null,
    label: 'All',
    x,
    y,
    width: allWidth,
    height: CHIP_HEIGHT,
  })
  x += allWidth + CHIP_GAP

  for (const cat of categories) {
    const metrics = ctx.measureText(cat)
    const width = metrics.width + CHIP_PADDING_X * 2
    // Bail out cleanly when the next chip won't fit — no wrapping
    // in v1 (categories that don't fit are simply unreachable).
    // Canvas width at 800 px holds ~5-7 typical-length chips plus
    // "All"; enough for the common categories without per-chip
    // scrolling.
    if (x + width > CANVAS_WIDTH - CHIP_MARGIN_X) break
    // Chip's `category` is the filter it applies when tapped —
    // just the category string. No toggle-off-by-tapping-active
    // cleverness; "All" is the reset path.
    chips.push({
      category: cat,
      label: cat,
      x,
      y,
      width,
      height: CHIP_HEIGHT,
    })
    x += width + CHIP_GAP
  }

  ctx.restore()
  return chips
}

function drawCanvas(
  ctx: CanvasRenderingContext2D,
  datasets: VrDatasetEntry[],
  categories: string[],
  selectedCategory: string | null,
  scrollY: number,
  highlightIndex: number,
  thumbnails: Map<string, HTMLImageElement>,
): void {
  const w = CANVAS_WIDTH
  const h = CANVAS_HEIGHT

  ctx.clearRect(0, 0, w, h)

  // Background + border
  ctx.fillStyle = BG_COLOR
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = BORDER_COLOR
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, w - 2, h - 2)

  // Title bar
  ctx.fillStyle = 'rgba(77, 166, 255, 0.12)'
  ctx.fillRect(0, 0, w, TITLE_BAR_HEIGHT)
  ctx.strokeStyle = BORDER_COLOR
  ctx.beginPath()
  ctx.moveTo(0, TITLE_BAR_HEIGHT)
  ctx.lineTo(w, TITLE_BAR_HEIGHT)
  ctx.stroke()

  // Title text (counts reflect the filtered list so the user can
  // see how many matched the current chip selection).
  ctx.fillStyle = TITLE_COLOR
  ctx.font = '600 28px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(`Browse Datasets (${datasets.length})`, 20, TITLE_BAR_HEIGHT / 2)

  // Close button
  ctx.fillStyle = ACCENT_COLOR
  ctx.font = '500 32px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('✕', w - 30, TITLE_BAR_HEIGHT / 2)

  // --- Chip row ---
  // Active chip lights up in accent; inactives use card-background
  // so they read as "tappable but not selected". The "All" chip
  // (chip.category === null) is active when no filter is set.
  // Divider line below separates chips from the list cleanly.
  const chips = layoutChips(ctx, categories)
  ctx.font = '500 15px system-ui, -apple-system, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  for (const chip of chips) {
    const isActive = chip.category === selectedCategory
    ctx.fillStyle = isActive ? ACCENT_COLOR : CARD_BG
    fillRoundRect(ctx, chip.x, chip.y, chip.width, chip.height, chip.height / 2)
    ctx.fillStyle = isActive ? '#ffffff' : TITLE_COLOR
    ctx.fillText(chip.label, chip.x + chip.width / 2, chip.y + chip.height / 2 + 1)
  }
  ctx.strokeStyle = BORDER_COLOR
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, CHIP_ROW_BOTTOM)
  ctx.lineTo(w, CHIP_ROW_BOTTOM)
  ctx.stroke()

  if (datasets.length === 0) {
    ctx.fillStyle = SUBTITLE_COLOR
    ctx.font = '400 22px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const emptyMsg = selectedCategory
      ? `No datasets in "${selectedCategory}"`
      : 'No datasets available'
    ctx.fillText(emptyMsg, w / 2, (h + LIST_TOP) / 2)
    return
  }

  // Clip to list area
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, LIST_TOP, w, LIST_HEIGHT)
  ctx.clip()

  const cardStride = CARD_HEIGHT + CARD_GAP
  const listContentWidth = w - LIST_PADDING * 2 - SCROLLBAR_WIDTH

  // Compute the visible-index window from scrollY so the draw loop
  // only iterates cards that can actually land inside the clipped
  // viewport. At XR frame rate (72-90 Hz) with large catalogs (100+
  // datasets), the old O(n) "loop-and-continue" cost showed up in
  // profiling; this collapses it to O(visible + 2 buffer). The
  // one-card buffer on each side avoids popping at the edges when
  // scrollY is mid-stride.
  const visibleBuffer = 1
  const startIndex = Math.max(0, Math.floor(scrollY / cardStride) - visibleBuffer)
  const endIndex = Math.min(
    datasets.length,
    Math.ceil((scrollY + LIST_HEIGHT) / cardStride) + visibleBuffer,
  )

  for (let i = startIndex; i < endIndex; i++) {
    const cardY = LIST_TOP + i * cardStride - scrollY

    const ds = datasets[i]
    const x = LIST_PADDING
    const cardW = listContentWidth

    // Card background
    ctx.fillStyle = i === highlightIndex ? CARD_BG_HOVER : CARD_BG
    fillRoundRect(ctx, x, cardY, cardW, CARD_HEIGHT, 6)

    // --- Thumbnail (left edge of card) ---
    // Mirrors the 2D browse UI — thumbnail gives a recognizable
    // visual even before the user reads the title. Cached loads
    // show up instantly; first sightings draw a placeholder tile
    // and trigger an async decode that'll appear on the next
    // redraw. Fallback to a simple globe glyph when a thumbnail
    // is missing or still loading.
    const thumbX = x + 6
    const thumbY = cardY + 6
    const thumbImg = ds.thumbnailUrl ? thumbnails.get(ds.thumbnailUrl) : null
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)'
    fillRoundRect(ctx, thumbX, thumbY, THUMB_SIZE, THUMB_SIZE, 4)
    if (thumbImg && thumbImg.complete && thumbImg.naturalWidth > 0) {
      // Rounded-corner clip around the thumbnail so it matches the
      // card's aesthetic. Save / restore so the clip doesn't
      // leak into later draws on this card (title + chip).
      ctx.save()
      ctx.beginPath()
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(thumbX, thumbY, THUMB_SIZE, THUMB_SIZE, 4)
      } else {
        ctx.rect(thumbX, thumbY, THUMB_SIZE, THUMB_SIZE)
      }
      ctx.clip()
      ctx.drawImage(thumbImg, thumbX, thumbY, THUMB_SIZE, THUMB_SIZE)
      ctx.restore()
    } else {
      // Placeholder glyph — small centered globe. Readable at
      // every font-fallback so we don't depend on a specific
      // emoji font being present.
      ctx.fillStyle = 'rgba(232, 234, 240, 0.35)'
      ctx.font = '500 28px system-ui, -apple-system, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('\u{1F30D}', thumbX + THUMB_SIZE / 2, thumbY + THUMB_SIZE / 2)
    }

    // --- Title + category (right of thumbnail) ---
    const textX = thumbX + THUMB_SIZE + THUMB_MARGIN_RIGHT
    const textMaxWidth = x + cardW - textX - CARD_PADDING_X

    ctx.fillStyle = TITLE_COLOR
    ctx.font = '500 20px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    let title = ds.title
    while (ctx.measureText(title).width > textMaxWidth && title.length > 4) {
      title = title.slice(0, -2) + '…'
    }
    ctx.fillText(title, textX, cardY + 14)

    // Category line (first category if any — the card only has
    // room for one at this height). The chip-filter still matches
    // any of the dataset's categories; this is cosmetic only.
    if (ds.categories.length > 0) {
      ctx.fillStyle = ACCENT_COLOR
      ctx.font = '400 14px system-ui, -apple-system, sans-serif'
      ctx.fillText(ds.categories[0], textX, cardY + 44)
    }
  }

  ctx.restore()

  // Scrollbar
  const totalContent = datasets.length * cardStride
  if (totalContent > LIST_HEIGHT) {
    const scrollbarHeight = Math.max(20, (LIST_HEIGHT / totalContent) * LIST_HEIGHT)
    const scrollbarY = LIST_TOP + (scrollY / (totalContent - LIST_HEIGHT)) * (LIST_HEIGHT - scrollbarHeight)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)'
    fillRoundRect(ctx, w - LIST_PADDING - SCROLLBAR_WIDTH, scrollbarY, SCROLLBAR_WIDTH, scrollbarHeight, 4)
  }
}

export function createVrBrowse(THREE_: typeof THREE): VrBrowseHandle {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_WIDTH
  canvas.height = CANVAS_HEIGHT
  const ctx2d = canvas.getContext('2d')
  if (!ctx2d) throw new Error('[VR Browse] 2D canvas context unavailable')

  const texture = new THREE_.CanvasTexture(canvas)
  texture.colorSpace = THREE_.SRGBColorSpace
  texture.minFilter = THREE_.LinearFilter
  texture.magFilter = THREE_.LinearFilter

  const material = new THREE_.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })

  const geometry = new THREE_.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT)
  const mesh = new THREE_.Mesh(geometry, material)
  mesh.renderOrder = 9
  mesh.visible = false

  let visible = false
  /** Full dataset catalog from the caller — never mutated. */
  let datasets: VrDatasetEntry[] = []
  /** Unique non-null categories in render order (first appearance). */
  let categories: string[] = []
  /** Current chip filter. null = show everything. */
  let selectedCategory: string | null = null
  /** Filtered view of `datasets` given the active category. Recomputed whenever datasets or filter changes. */
  let visibleDatasets: VrDatasetEntry[] = []
  let scrollY = 0
  let highlightIndex = -1

  /**
   * Keyed by thumbnail URL. `Image` is the common DOM type that
   * Canvas 2D's `drawImage` accepts directly, so we don't need to
   * round-trip through a bitmap. Cache by URL so revisiting the
   * same dataset in a later session reuses the decoded image and
   * doesn't re-hit the network.
   */
  const thumbnailCache = new Map<string, HTMLImageElement>()

  /**
   * Kick off async decode of every thumbnail URL in the current
   * catalog. Each `Image` triggers its own redraw on `load` so the
   * thumb appears as soon as the bytes arrive — matches the
   * progressive-render pattern the 2D browse panel uses.
   */
  function loadThumbnails(): void {
    for (const d of datasets) {
      if (!d.thumbnailUrl || thumbnailCache.has(d.thumbnailUrl)) continue
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.decoding = 'async'
      // Tight coupling to the URL as cache key — survives setDatasets
      // calls, so reshuffles don't re-fetch. Errors leave the entry
      // in the cache as an incomplete Image so `complete &&
      // naturalWidth > 0` stays false and the placeholder renders.
      thumbnailCache.set(d.thumbnailUrl, img)
      img.onload = () => {
        if (visible) redraw()
      }
      img.onerror = () => {
        // Leave the entry; subsequent renders fall through to the
        // placeholder glyph. No retry.
      }
      img.src = d.thumbnailUrl
    }
  }

  /** Rebuild the `visibleDatasets` slice when datasets or filter change. */
  function recomputeFilter(): void {
    visibleDatasets = selectedCategory
      ? datasets.filter(d => d.categories.includes(selectedCategory!))
      : datasets
  }

  /**
   * Recompute the set of unique categories across the catalog.
   * Sorted alphabetically so the chip order is stable and matches
   * the 2D browse UI's behavior. Each dataset may contribute
   * multiple categories (union of enriched.categories keys and
   * tags — built in main.ts:getDatasets).
   */
  function recomputeCategories(): void {
    const seen = new Set<string>()
    for (const d of datasets) {
      for (const c of d.categories) seen.add(c)
    }
    categories = Array.from(seen).sort()
  }

  function clampScroll(): void {
    const totalContent = visibleDatasets.length * (CARD_HEIGHT + CARD_GAP)
    const maxScroll = Math.max(0, totalContent - LIST_HEIGHT)
    scrollY = Math.max(0, Math.min(maxScroll, scrollY))
  }

  function redraw(): void {
    drawCanvas(ctx2d!, visibleDatasets, categories, selectedCategory, scrollY, highlightIndex, thumbnailCache)
    texture.needsUpdate = true
  }

  redraw()

  /** Convert UV hit to the card index at that position (into visibleDatasets). */
  function cardIndexAtUv(u: number, v: number): number {
    const canvasX = u * CANVAS_WIDTH
    const canvasY = (1 - v) * CANVAS_HEIGHT
    if (canvasY < LIST_TOP || canvasY > LIST_BOTTOM) return -1
    if (canvasX < LIST_PADDING || canvasX > CANVAS_WIDTH - LIST_PADDING - SCROLLBAR_WIDTH) return -1
    const cardStride = CARD_HEIGHT + CARD_GAP
    const idx = Math.floor((canvasY - LIST_TOP + scrollY) / cardStride)
    if (idx < 0 || idx >= visibleDatasets.length) return -1
    const withinCard = (canvasY - LIST_TOP + scrollY) % cardStride
    if (withinCard > CARD_HEIGHT) return -1
    return idx
  }

  /**
   * Chip hit at UV, or null if the ray landed elsewhere in the chip
   * row. Returned `category` is the filter the tap applies —
   * `null` for the "All" chip (clears the filter), the category
   * string for a specific-category chip.
   */
  function chipAtUv(u: number, v: number): { category: string | null } | null {
    const canvasX = u * CANVAS_WIDTH
    const canvasY = (1 - v) * CANVAS_HEIGHT
    if (canvasY < CHIP_ROW_TOP || canvasY > CHIP_ROW_BOTTOM) return null
    const chips = layoutChips(ctx2d!, categories)
    for (const chip of chips) {
      if (
        canvasX >= chip.x && canvasX <= chip.x + chip.width &&
        canvasY >= chip.y && canvasY <= chip.y + chip.height
      ) {
        return { category: chip.category }
      }
    }
    return null
  }

  return {
    mesh,

    setVisible(v) {
      visible = v
      mesh.visible = v
      if (v) redraw()
    },

    isVisible() {
      return visible
    },

    setDatasets(ds) {
      datasets = ds
      recomputeCategories()
      // If the previously-selected category no longer exists in the
      // new catalog (shouldn't happen on the normal path but easy
      // to be defensive about), clear the filter so we don't render
      // an empty list with no way to recover.
      if (selectedCategory && !categories.includes(selectedCategory)) {
        selectedCategory = null
      }
      recomputeFilter()
      // Kick off thumbnail loads — async, each fires its own redraw
      // on load so the thumb pops in as soon as the bytes arrive.
      loadThumbnails()
      scrollY = 0
      highlightIndex = -1
      if (visible) redraw()
    },

    setCategoryFilter(category) {
      selectedCategory = category
      recomputeFilter()
      scrollY = 0
      if (visible) redraw()
    },

    scroll(delta) {
      if (!visible || visibleDatasets.length === 0) return
      const previousScrollY = scrollY
      scrollY += delta
      clampScroll()
      // If the clamped value didn't actually move (user holding the
      // thumbstick at end-of-list, or list too short to scroll),
      // skip the canvas repaint. Matters at XR frame rate —
      // drawCanvas isn't free, and there's no visual change to
      // justify it.
      if (scrollY !== previousScrollY) redraw()
    },

    hitTest(uv) {
      if (!visible) return null
      const { x: u, y: v } = uv

      // Close button
      if (
        u >= CLOSE_BUTTON.uMin && u <= CLOSE_BUTTON.uMax &&
        v >= CLOSE_BUTTON.vMin && v <= CLOSE_BUTTON.vMax
      ) {
        return { kind: 'close' }
      }

      // Category chip — test before the list region so chip taps
      // at the boundary don't fall through to the list.
      const chip = chipAtUv(u, v)
      if (chip) {
        return { kind: 'category', category: chip.category }
      }

      // Dataset card
      const idx = cardIndexAtUv(u, v)
      if (idx >= 0) {
        return { kind: 'select', datasetId: visibleDatasets[idx].id }
      }

      return null
    },

    dispose() {
      texture.dispose()
      material.dispose()
      geometry.dispose()
    },
  }
}
