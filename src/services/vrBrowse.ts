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
const CARD_HEIGHT = 56
const CARD_GAP = 4
const CARD_PADDING_X = 16
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
   * Tapped a category chip. `category === null` means the user
   * tapped the active chip again (toggle off) — caller should
   * clear the filter. Otherwise filter the list to that category.
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
 * One rendered chip's pixel rect. Precomputed each layout pass so
 * the draw loop and the hit-test loop agree byte-for-byte on where
 * each chip lives.
 */
interface ChipRect {
  category: string | null // null = the active chip tapped again (toggle off)
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
  selectedCategory: string | null,
): ChipRect[] {
  const chips: ChipRect[] = []
  ctx.save()
  ctx.font = '500 15px system-ui, -apple-system, sans-serif'

  let x = CHIP_MARGIN_X
  const y = CHIP_ROW_TOP + CHIP_VERTICAL_OFFSET

  for (const cat of categories) {
    const metrics = ctx.measureText(cat)
    const width = metrics.width + CHIP_PADDING_X * 2
    // Bail out cleanly when the next chip won't fit — no wrapping
    // in v1 (categories that don't fit are simply unreachable).
    // Canvas width at 800 px holds ~5-7 typical-length chips;
    // enough for the common categories without per-chip scrolling.
    if (x + width > CANVAS_WIDTH - CHIP_MARGIN_X) break
    // `category: cat` on a chip tap means "filter to this category";
    // the hit-test post-processing maps to `null` (toggle off) when
    // the user taps the already-selected chip.
    chips.push({
      category: cat === selectedCategory ? null : cat,
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
  // so they read as "tappable but not selected". Divider line below
  // separates chips from the list cleanly.
  const chips = layoutChips(ctx, categories, selectedCategory)
  ctx.font = '500 15px system-ui, -apple-system, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  for (const chip of chips) {
    const isActive = chip.label === selectedCategory
    ctx.fillStyle = isActive ? ACCENT_COLOR : CARD_BG
    ctx.beginPath()
    ctx.roundRect(chip.x, chip.y, chip.width, chip.height, chip.height / 2)
    ctx.fill()
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

  for (let i = 0; i < datasets.length; i++) {
    const cardY = LIST_TOP + i * cardStride - scrollY
    if (cardY + CARD_HEIGHT < LIST_TOP || cardY > LIST_BOTTOM) continue

    const ds = datasets[i]
    const x = LIST_PADDING
    const cardW = listContentWidth

    // Card background
    ctx.fillStyle = i === highlightIndex ? CARD_BG_HOVER : CARD_BG
    ctx.beginPath()
    ctx.roundRect(x, cardY, cardW, CARD_HEIGHT, 6)
    ctx.fill()

    // Title
    ctx.fillStyle = TITLE_COLOR
    ctx.font = '500 20px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    let title = ds.title
    const maxTitleWidth = cardW - CARD_PADDING_X * 2
    while (ctx.measureText(title).width > maxTitleWidth && title.length > 4) {
      title = title.slice(0, -2) + '…'
    }
    ctx.fillText(title, x + CARD_PADDING_X, cardY + 10)

    // Category chip
    if (ds.category) {
      ctx.fillStyle = ACCENT_COLOR
      ctx.font = '400 14px system-ui, -apple-system, sans-serif'
      ctx.fillText(ds.category, x + CARD_PADDING_X, cardY + 35)
    }
  }

  ctx.restore()

  // Scrollbar
  const totalContent = datasets.length * cardStride
  if (totalContent > LIST_HEIGHT) {
    const scrollbarHeight = Math.max(20, (LIST_HEIGHT / totalContent) * LIST_HEIGHT)
    const scrollbarY = LIST_TOP + (scrollY / (totalContent - LIST_HEIGHT)) * (LIST_HEIGHT - scrollbarHeight)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)'
    ctx.beginPath()
    ctx.roundRect(w - LIST_PADDING - SCROLLBAR_WIDTH, scrollbarY, SCROLLBAR_WIDTH, scrollbarHeight, 4)
    ctx.fill()
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

  /** Rebuild the `visibleDatasets` slice when datasets or filter change. */
  function recomputeFilter(): void {
    visibleDatasets = selectedCategory
      ? datasets.filter(d => d.category === selectedCategory)
      : datasets
  }

  /** Recompute unique categories in first-appearance order. */
  function recomputeCategories(): void {
    const seen = new Set<string>()
    categories = []
    for (const d of datasets) {
      if (d.category && !seen.has(d.category)) {
        seen.add(d.category)
        categories.push(d.category)
      }
    }
  }

  function clampScroll(): void {
    const totalContent = visibleDatasets.length * (CARD_HEIGHT + CARD_GAP)
    const maxScroll = Math.max(0, totalContent - LIST_HEIGHT)
    scrollY = Math.max(0, Math.min(maxScroll, scrollY))
  }

  function redraw(): void {
    drawCanvas(ctx2d!, visibleDatasets, categories, selectedCategory, scrollY, highlightIndex)
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
   * row. Returned `category` is whichever the chip's own `category`
   * field says — by convention that field encodes the toggle
   * (`null` if the chip is currently active, the category string
   * otherwise). See layoutChips for the encoding.
   */
  function chipAtUv(u: number, v: number): { category: string | null } | null {
    const canvasX = u * CANVAS_WIDTH
    const canvasY = (1 - v) * CANVAS_HEIGHT
    if (canvasY < CHIP_ROW_TOP || canvasY > CHIP_ROW_BOTTOM) return null
    const chips = layoutChips(ctx2d!, categories, selectedCategory)
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
      scrollY += delta
      clampScroll()
      redraw()
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
