/**
 * Catalog Graph view — UI mount + cytoscape.js wiring.
 *
 * Phase 4 §6.7 of `docs/WEB_CATALOG_FEATURES_PLAN.md`. The pure
 * data transform lives in `src/services/catalogGraph.ts`; this
 * module owns the canvas, the cytoscape instance, the
 * interaction handlers, and the in-graph controls (min-edge-weight
 * slider, recenter button, expand/collapse keyword affordance).
 *
 * Lazy-loaded — `browseUI.ts` imports `createCatalogGraph` only
 * when the user first toggles into Graph view, so the default
 * Cards path pays nothing for cytoscape. Mirrors the Three.js
 * pattern in `vrSession.ts`.
 */

import cytoscape from 'cytoscape'
import type { Core, ElementDefinition, NodeSingular, EventObject } from 'cytoscape'
import cola from 'cytoscape-cola'

import {
  buildGraph,
  topCoOccurrences,
  type Graph,
  type GraphNode,
} from '../services/catalogGraph'

// Register the cola layout extension once per page load. Idempotent
// against repeated imports — cytoscape ignores duplicate registrations.
cytoscape.use(cola)
import {
  type FilterState,
} from '../services/datasetFilter'
import type { Dataset } from '../types'
import { emit } from '../analytics'
import { hashQuery } from '../analytics/hash'
import { escapeHtml, escapeAttr } from './domUtils'
import { t } from '../i18n'
import { formatNumber } from '../i18n/format'

/** Top-N keywords each Category cluster auto-radiates when no
 *  explicit expansion is in effect. Tuned to ~5-8 per the GSL
 *  Depot Explorer reference: dense enough to read the hub-and-
 *  spoke structure, sparse enough to keep the canvas legible. */
const DEFAULT_AUTO_EXPAND_PER_CLUSTER = 6
/** Per-minute throttle budget for `catalog_graph_node_clicked` —
 *  matches `camera_settled`'s budget so an aggressive user can't
 *  flood the queue from either surface. The 60 s rolling window
 *  is the same. */
const NODE_CLICK_MAX_PER_MINUTE = 30
const NODE_CLICK_WINDOW_MS = 60_000

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface CatalogGraphCallbacks {
  /** Single mutation path for chip + Graph + Timeline + Map per
   *  §6.7 — node clicks call back via this so the chip rail reacts
   *  identically. */
  onToggleFacet: (facet: string, value: string) => void
  /** Same path the card grid uses to open the info panel. */
  onSelectDataset: (datasetId: string) => void
}

export interface CatalogGraphUpdate {
  datasets: readonly Dataset[]
  filterState: FilterState
  /** Free-text portion of the search query (prefix tokens are
   *  already merged into filterState by the caller). */
  searchQuery: string
}

export interface CatalogGraphController {
  /** Re-render with the current dataset / filter state. Cytoscape's
   *  incremental layout animates node positions rather than re-
   *  seeding the simulation. */
  update: (input: CatalogGraphUpdate) => void
  /** Tear down the cytoscape instance. Called on hideBrowseUI if
   *  the consumer wants to free WebGL contexts; not currently
   *  invoked. */
  destroy: () => void
}

// ---------------------------------------------------------------------------
// Cytoscape style — colour values are resolved from the
// `--facet-color-*` CSS tokens at cytoscape-init time so the canvas
// renderer (which can't read CSS custom properties at draw time)
// still picks up the design system's source of truth.
// ---------------------------------------------------------------------------

/** Resolve a CSS custom property against `:root` so cytoscape's
 *  canvas renderer can use it. Falls back to a sensible literal
 *  when the var is missing (token regen failed / SSR shell). */
function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = window.getComputedStyle(document.documentElement)
    .getPropertyValue(name).trim()
  return value || fallback
}

interface ResolvedTokens {
  category: string
  format: string
  time: string
  quality: string
  datasetGrey: string
  bg: string
  text: string
  textSecondary: string
  accent: string
  borderSoft: string
  edgeMembership: string
}

function resolveTokens(): ResolvedTokens {
  return {
    category: cssVar('--facet-color-category-content', '#5cc8c8'),
    format: cssVar('--facet-color-format-medium', '#c486f7'),
    time: cssVar('--facet-color-time', '#f59f4a'),
    quality: cssVar('--facet-color-quality-availability', '#6dc96d'),
    datasetGrey: cssVar('--color-text-faint', '#666'),
    bg: cssVar('--color-bg', '#0d0d12'),
    text: cssVar('--color-text', '#e8eaf0'),
    textSecondary: cssVar('--color-text-secondary', '#bbb'),
    accent: cssVar('--color-accent', '#4da6ff'),
    borderSoft: cssVar('--white-o20', 'rgba(255, 255, 255, 0.2)'),
    edgeMembership: cssVar('--white-o10', 'rgba(255, 255, 255, 0.1)'),
  }
}

// ---------------------------------------------------------------------------
// Cola layout (continuous force-directed)
// ---------------------------------------------------------------------------

/**
 * Cola layout options shared by the initial layout and every
 * subsequent rebuild.
 *
 * NOT `infinite: true`. The first version of this code set
 * `infinite: true` for "drag a node, others follow" — but the
 * continuous simulation fought wheel-zoom in browser testing,
 * apparently triggering a viewport-related side effect on every
 * animation-frame iteration. Drag-to-follow now comes from a
 * `grab`-handler that re-runs cola for the duration of the drag
 * (`wireCyEvents` below). Cola's constraint solver naturally pins
 * grabbed nodes to the mouse and relaxes everything else around
 * them.
 *
 * `randomize` is true only on first instantiation; subsequent
 * rebuild calls reuse positions so chip-toggle thrashes don't
 * re-seed the simulation (the §6.7 "graph thrash" risk).
 *
 * `edgeLength` is keyed by edge kind:
 *
 *   - co-occurrence edges → longer (the Category and Format hubs
 *     should sit apart so the visual hierarchy reads)
 *   - membership edges    → shorter (dataset nodes hug their hub)
 *
 * Typed via cast because cytoscape-cola's options aren't on
 * `cytoscape.LayoutOptions` and we don't ship type defs for the
 * extension.
 */
function colaLayoutOptions(randomize: boolean): cytoscape.LayoutOptions {
  return {
    name: 'cola',
    animate: true,
    refresh: 1,
    maxSimulationTime: 2500,
    ungrabifyWhileSimulating: false,
    fit: randomize,
    padding: 30,
    randomize,
    avoidOverlap: true,
    handleDisconnected: true,
    nodeSpacing: 8,
    centerGraph: false,
    edgeLength: (edge: { data: (key: string) => unknown }) => {
      const kind = edge.data('kind')
      if (kind === 'co-occurrence') return 160
      return 60
    },
  } as unknown as cytoscape.LayoutOptions
}

/** Stop any previous cola layout and start a new one. Without
 *  stopping first, a re-run started during an in-flight layout
 *  would leave the previous one running its animation frames in
 *  parallel — wasted work and conflicting position writes. */
function startColaLayout(instance: Core, randomize: boolean): void {
  // Cytoscape's typings expose a generic `stop()` on layouts but
  // the typing surface for in-flight layouts is anaemic. Cast.
  type LayoutHandle = ReturnType<Core['layout']> & { stop?: () => void }
  const prev = (instance as Core & { _colaLayout?: LayoutHandle })._colaLayout
  if (prev?.stop) {
    try { prev.stop() } catch { /* layout already torn down */ }
  }
  const layout = instance.layout(colaLayoutOptions(randomize))
  ;(instance as Core & { _colaLayout?: LayoutHandle })._colaLayout = layout as LayoutHandle
  layout.run()
}

// ---------------------------------------------------------------------------
// Module entry — instantiate and return a controller
// ---------------------------------------------------------------------------

/**
 * Build the in-DOM chrome (toolbar, canvas, tooltip) and a fresh
 * cytoscape instance. Caller passes the host container — typically
 * `<div id="browse-graph">` from `index.html`. Returns a
 * controller exposing `update` and `destroy`.
 *
 * The host element's children are replaced; callers should pass an
 * empty container (or accept that its previous contents are
 * cleared).
 */
export function createCatalogGraph(
  host: HTMLElement,
  callbacks: CatalogGraphCallbacks,
): CatalogGraphController {
  host.innerHTML = ''
  host.classList.add('browse-graph-host')

  // --- Toolbar (min-edge-weight slider + recenter button) ---
  // Legend swatches resolve their hue from inline `var(--facet-color-*)`
  // — the legend lives in regular DOM (not cytoscape's canvas) so
  // CSS variables work directly here.
  const toolbar = document.createElement('div')
  toolbar.className = 'browse-graph-toolbar'
  toolbar.innerHTML = `
    <label class="browse-graph-show-format">
      <input type="checkbox"
             class="browse-graph-show-format-input"
             aria-label="${escapeAttr(t('browse.graph.showFormat.aria'))}" />
      <span>${escapeHtml(t('browse.graph.showFormat.label'))}</span>
    </label>
    <button type="button"
            class="browse-graph-recenter"
            aria-label="${escapeAttr(t('browse.graph.recenter.aria'))}">
      ${escapeHtml(t('browse.graph.recenter'))}
    </button>
    <div class="browse-graph-legend" aria-hidden="true">
      <span class="browse-graph-legend-dot browse-graph-legend-dot-category"></span>${escapeHtml(t('browse.graph.legend.category'))}
      <span class="browse-graph-legend-dot browse-graph-legend-dot-format browse-graph-legend-dot-format-toggle"></span>${escapeHtml(t('browse.graph.legend.format'))}
      <span class="browse-graph-legend-dot browse-graph-legend-dot-keyword"></span>${escapeHtml(t('browse.graph.legend.keyword'))}
      <span class="browse-graph-legend-dot browse-graph-legend-dot-dataset"></span>${escapeHtml(t('browse.graph.legend.dataset'))}
    </div>
  `

  const canvas = document.createElement('div')
  canvas.className = 'browse-graph-canvas'
  // The aria-label on the region is updated by `update()` once the
  // first build runs — the static fallback keeps screen readers
  // from announcing an empty value while loading.
  canvas.setAttribute('role', 'region')
  canvas.setAttribute('aria-label', t('browse.graph.loading'))

  const tooltip = document.createElement('div')
  tooltip.className = 'browse-graph-tooltip hidden'
  tooltip.setAttribute('role', 'tooltip')
  tooltip.setAttribute('aria-hidden', 'true')

  const emptyState = document.createElement('div')
  emptyState.className = 'browse-graph-empty hidden'
  emptyState.setAttribute('role', 'status')
  emptyState.textContent = t('browse.graph.empty')

  host.appendChild(toolbar)
  host.appendChild(canvas)
  host.appendChild(tooltip)
  host.appendChild(emptyState)

  // --- State carried across update() calls ---
  let cy: Core | null = null
  let lastGraph: Graph | null = null
  let lastInput: CatalogGraphUpdate | null = null
  let showFormat = false
  const expandedKeywordParents = new Set<string>()
  // Rolling timestamps for node-click throttling. Matches the
  // pattern in `src/analytics/camera.ts`.
  const clickEmits: number[] = []

  function rebuild(): void {
    if (!lastInput) return
    const graph = buildGraph(
      lastInput.datasets,
      lastInput.filterState,
      lastInput.searchQuery,
      {
        // minEdgeWeight intentionally omitted — the service's
        // default (2) suppresses singleton co-occurrences, which
        // is the only behaviour we want. The slider that exposed
        // this option was removed (PR #137 review) because the
        // catalog's 4×11 Category↔Format grid produces
        // high-weight edges where the 1→10 range barely changed
        // density.
        expandedKeywordParents,
        autoExpandKeywordsPerCluster: DEFAULT_AUTO_EXPAND_PER_CLUSTER,
        includeFormatNodes: showFormat,
      },
    )
    lastGraph = graph

    if (graph.filteredDatasetCount === 0) {
      emptyState.classList.remove('hidden')
      canvas.classList.add('hidden')
      if (cy) {
        cy.elements().remove()
      }
      canvas.setAttribute(
        'aria-label',
        t('browse.graph.region.aria', { count: 0, edgeCount: 0 }),
      )
      return
    }
    emptyState.classList.add('hidden')
    canvas.classList.remove('hidden')

    const elements = graphToCytoscape(graph)
    if (cy) {
      // Incremental update — preserve node positions where possible.
      // Diff against the current element set: keep nodes whose ID
      // still exists, remove the rest, add the newcomers. Cytoscape's
      // built-in `json()` would re-seed positions; this approach
      // keeps spatial memory intact across chip-toggle thrashes per
      // §6.7's "graph thrash" risk note.
      const existingIds = new Set<string>()
      cy.elements().forEach(el => { existingIds.add(el.id()) })
      const nextIds = new Set<string>(elements.map(e => e.data.id as string))
      cy.batch(() => {
        // Remove elements no longer present
        cy!.elements().forEach(el => {
          if (!nextIds.has(el.id())) el.remove()
        })
        // Add elements that weren't present before
        const additions = elements.filter(e => !existingIds.has(e.data.id as string))
        if (additions.length > 0) cy!.add(additions)
        // Update data on existing nodes AND edges. datasetCount can
        // shift when filters tighten without the node ID changing,
        // and co-occurrence edge `weight` (which drives stroke width
        // via mapData) shifts whenever Category↔Format intersections
        // change. Without this loop existing edges would keep their
        // previous weight after a filter change.
        for (const el of elements) {
          const id = el.data.id as string
          if (!existingIds.has(id)) continue
          if (el.group !== 'nodes' && el.group !== 'edges') continue
          const existing = cy!.getElementById(id)
          if (existing.empty()) continue
          for (const [key, value] of Object.entries(el.data)) {
            // `source` / `target` are immutable on cytoscape edges;
            // edge IDs are deterministically derived from them so an
            // ID-stable edge always has identical endpoints.
            if (key === 'id' || key === 'source' || key === 'target') continue
            existing.data(key, value)
          }
        }
      })
      // Re-run cola in incremental mode — node positions stay put,
      // newly-added nodes find a spot, and the simulation relaxes
      // around the diff. The drag-to-follow feel comes from a
      // separate `grab`-triggered re-run in `wireCyEvents` (cola
      // here runs in finite mode; `infinite: true` was dropped in
      // 1bc6d79 because it was fighting wheel-zoom).
      startColaLayout(cy, false)
    } else {
      cy = cytoscape({
        container: canvas,
        elements,
        style: buildCytoscapeStyle(resolveTokens()),
        // First layout — let cola randomize positions for an initial
        // settle; subsequent updates reuse positions.
        layout: colaLayoutOptions(true),
        wheelSensitivity: 0.3,
        minZoom: 0.2,
        maxZoom: 3,
        boxSelectionEnabled: false,
        autounselectify: true,
      })
      wireCyEvents(cy)
    }

    canvas.setAttribute(
      'aria-label',
      t('browse.graph.region.aria', {
        count: formatNumber(graph.filteredDatasetCount),
        edgeCount: formatNumber(graph.edges.length),
      }),
    )
  }

  /** Wire cytoscape event handlers — click / dblclick / hover.
   *  Wired once per cytoscape instance creation; rebuild only
   *  swaps elements within the existing instance, so handlers
   *  survive update calls. */
  function wireCyEvents(instance: Core): void {
    instance.on('tap', 'node', (evt: EventObject) => {
      const node = evt.target as NodeSingular
      const kind = node.data('kind') as GraphNode['kind']
      if (kind === 'facet-value') {
        const facet = node.data('facet') as string
        const value = node.data('value') as string
        emitNodeClick(kind, facet, value)
        callbacks.onToggleFacet(facet, value)
        return
      }
      if (kind === 'dataset') {
        const datasetId = node.data('datasetId') as string
        emitNodeClick(kind, '', datasetId)
        callbacks.onSelectDataset(datasetId)
        return
      }
      if (kind === 'keyword') {
        const value = node.data('value') as string
        emitNodeClick(kind, 'keyword', value)
        // Keywords click into the search box as a free-text query
        // — they aren't a chip-rail facet today, so funnel through
        // toggleFacet with the `keyword` facet name which the
        // engine's baseline resolver handles.
        callbacks.onToggleFacet('keyword', value)
      }
    })

    instance.on('dblclick', 'node[kind="facet-value"]', (evt: EventObject) => {
      const node = evt.target as NodeSingular
      // Centre the graph on the double-clicked node — the §6.7
      // "hub-and-spoke" interaction. Cytoscape's `center()` and
      // `zoom()` together implement the camera move; we don't
      // re-seed the layout, just point the camera.
      instance.animate({
        center: { eles: node },
        zoom: Math.min(instance.zoom() * 1.4, 3),
        duration: 350,
      })
      // Expand keyword children of the focused facet-value when the
      // user double-clicks. Toggle-style — second double-click
      // collapses again.
      const id = node.id()
      if (expandedKeywordParents.has(id)) {
        expandedKeywordParents.delete(id)
      } else {
        expandedKeywordParents.add(id)
      }
      rebuild()
    })

    instance.on('mouseover', 'node', (evt: EventObject) => {
      const node = evt.target as NodeSingular
      showTooltip(node)
    })
    instance.on('mouseout', 'node', () => hideTooltip())
    instance.on('pan zoom', () => hideTooltip())

    // Drag-to-follow — re-run cola on grab. Cola pins the grabbed
    // node to the user's mouse position and relaxes constraints
    // around it, so connected nodes follow naturally during the
    // drag. The simulation auto-stops after `maxSimulationTime`
    // (2.5 s) so it doesn't fight wheel-zoom once the user
    // releases. Re-runs are cheap because positions are reused
    // (randomize:false) — cola picks up from the current state.
    instance.on('grab', 'node', () => {
      startColaLayout(instance, false)
    })
  }

  function showTooltip(node: NodeSingular): void {
    if (!lastGraph) return
    const kind = node.data('kind') as GraphNode['kind']
    const label = node.data('label') as string
    const count = node.data('datasetCount') as number
    let body = `<strong>${escapeHtml(label)}</strong>`
    body += `<br><span class="browse-graph-tooltip-count">${escapeHtml(t('browse.graph.tooltip.datasetCount', { count: formatNumber(count) }))}</span>`
    if (kind === 'facet-value') {
      const top = topCoOccurrences(lastGraph, node.id(), 3)
      if (top.length > 0) {
        // Pass the plain (non-HTML) neighbours string into t() so a
        // translator can reorder the placeholder inside the message
        // (e.g. RTL languages may want the count to lead). HTML
        // escape the entire result once — neighbour labels are
        // already plain strings, so a single escape pass is correct.
        // Format-bucket values are localised via displayLabelFor()
        // so the tooltip reads "Video (3)" rather than "video (3)".
        const neighbours = top.map(entry => {
          const neighbour = lastGraph!.nodes.find(n => n.id === entry.neighbourId)
          return neighbour ? `${displayLabelFor(neighbour)} (${entry.weight})` : ''
        }).filter(Boolean).join(', ')
        if (neighbours) {
          body += `<br><span class="browse-graph-tooltip-cooc">${escapeHtml(t('browse.graph.tooltip.coOccurrence', { neighbours }))}</span>`
        }
      }
    }
    tooltip.innerHTML = body
    tooltip.classList.remove('hidden')
    tooltip.setAttribute('aria-hidden', 'false')
    // Position next to the node in canvas coordinates. Cytoscape's
    // `renderedPosition()` returns pixel coords relative to the
    // canvas; we then offset the tooltip relative to `host`.
    const pos = node.renderedPosition()
    const hostRect = host.getBoundingClientRect()
    const canvasRect = canvas.getBoundingClientRect()
    const offsetTop = canvasRect.top - hostRect.top
    const offsetLeft = canvasRect.left - hostRect.left
    tooltip.style.insetInlineStart = `${offsetLeft + pos.x + 14}px`
    tooltip.style.insetBlockStart = `${offsetTop + pos.y - 8}px`
  }

  function hideTooltip(): void {
    tooltip.classList.add('hidden')
    tooltip.setAttribute('aria-hidden', 'true')
  }

  function emitNodeClick(
    kind: GraphNode['kind'],
    facet: string,
    value: string,
  ): void {
    const now = Date.now()
    const cutoff = now - NODE_CLICK_WINDOW_MS
    while (clickEmits.length > 0 && clickEmits[0] < cutoff) clickEmits.shift()
    if (clickEmits.length >= NODE_CLICK_MAX_PER_MINUTE) return
    clickEmits.push(now)
    void hashQuery(value).then((value_hash) => {
      emit({
        event_type: 'catalog_graph_node_clicked',
        node_kind: kind,
        facet,
        value_hash,
      })
    })
  }

  // --- Toolbar wiring ---
  toolbar.querySelector('.browse-graph-recenter')?.addEventListener('click', () => {
    cy?.fit(undefined, 40)
  })

  // --- Show-format toggle ---
  const showFormatInput = toolbar.querySelector(
    '.browse-graph-show-format-input',
  ) as HTMLInputElement | null
  showFormatInput?.addEventListener('change', () => {
    showFormat = !!showFormatInput.checked
    host.classList.toggle('browse-graph-host-show-format', showFormat)
    rebuild()
  })

  return {
    update(input: CatalogGraphUpdate) {
      lastInput = input
      rebuild()
    },
    destroy() {
      if (cy) {
        cy.destroy()
        cy = null
      }
      host.innerHTML = ''
    },
  }
}

// ---------------------------------------------------------------------------
// Graph → cytoscape element definition
// ---------------------------------------------------------------------------

/**
 * Pick the user-facing label for a graph node. The pure transform
 * in `catalogGraph.ts` emits the raw facet-value string (`'video'`,
 * `'Water'`) because it's locale-independent; the UI is responsible
 * for localising at render time.
 *
 * Only `format` bucket values have a localised vocabulary today
 * (`browse.filter.format.video` / `.image` / `.tour` / `.other` —
 * mirrors the chip rail's labels in `browseUI.ts`). Category tag
 * values come from the SOS catalog's canonical taxonomy and are
 * presented verbatim; keyword values are author-written and also
 * locale-independent.
 */
function displayLabelFor(node: GraphNode): string {
  if (node.kind === 'facet-value' && node.facet === 'format') {
    switch (node.value) {
      case 'video': return t('browse.filter.format.video')
      case 'image': return t('browse.filter.format.image')
      case 'tour': return t('browse.filter.format.tour')
      case 'other': return t('browse.filter.format.other')
    }
  }
  return node.label
}

function graphToCytoscape(graph: Graph): ElementDefinition[] {
  const elements: ElementDefinition[] = []
  for (const node of graph.nodes) {
    const base: Record<string, unknown> = {
      id: node.id,
      kind: node.kind,
      label: displayLabelFor(node),
      group: node.group,
      datasetCount: node.datasetCount,
    }
    if (node.kind === 'facet-value') {
      base.facet = node.facet
      base.value = node.value
    } else if (node.kind === 'keyword') {
      base.value = node.value
      base.parentFacetValueId = node.parentFacetValueId
    } else if (node.kind === 'dataset') {
      base.datasetId = node.datasetId
    }
    elements.push({ group: 'nodes', data: base })
  }
  for (const edge of graph.edges) {
    elements.push({
      group: 'edges',
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
        weight: edge.weight,
      },
    })
  }
  return elements
}

/** Cytoscape stylesheet. Cytoscape's canvas renderer doesn't read
 *  CSS custom properties at draw time, so we resolve the design
 *  tokens once via `resolveTokens()` and pass the literal values in.
 *  Per-group hue is selector-driven (`node[group="..."]`) so each
 *  facet group keeps its own colour without a per-node data
 *  duplication. Sizes scale with `datasetCount` via cytoscape's
 *  built-in `mapData` so a heavily-occupied facet reads as a
 *  larger hub. */
function buildCytoscapeStyle(tokens: ResolvedTokens): cytoscape.StylesheetStyle[] {
  const styles: cytoscape.StylesheetStyle[] = [
    {
      selector: 'node[kind="facet-value"]',
      style: {
        label: 'data(label)',
        color: tokens.text,
        'font-size': 12,
        'text-outline-color': tokens.bg,
        'text-outline-width': 2,
        'text-valign': 'center',
        'text-halign': 'center',
        width: 'mapData(datasetCount, 1, 80, 24, 64)',
        height: 'mapData(datasetCount, 1, 80, 24, 64)',
        'border-width': 1,
        'border-color': tokens.borderSoft,
      },
    },
    {
      selector: 'node[group="category-content"]',
      style: { 'background-color': tokens.category },
    },
    {
      selector: 'node[group="format-medium"]',
      style: { 'background-color': tokens.format },
    },
    {
      selector: 'node[group="time"]',
      style: { 'background-color': tokens.time },
    },
    {
      selector: 'node[group="quality-availability"]',
      style: { 'background-color': tokens.quality },
    },
    {
      selector: 'node[kind="keyword"]',
      style: {
        'background-opacity': 0.6,
        label: 'data(label)',
        color: tokens.textSecondary,
        'font-size': 9,
        'text-outline-color': tokens.bg,
        'text-outline-width': 1,
        'text-valign': 'center',
        'text-halign': 'center',
        width: 'mapData(datasetCount, 1, 50, 14, 36)',
        height: 'mapData(datasetCount, 1, 50, 14, 36)',
        shape: 'round-rectangle',
      },
    },
    {
      selector: 'node[kind="dataset"]',
      style: {
        'background-color': tokens.datasetGrey,
        width: 8,
        height: 8,
        label: '',
      },
    },
    {
      selector: 'edge[kind="membership"]',
      style: {
        width: 0.5,
        'line-color': tokens.edgeMembership,
        'curve-style': 'bezier',
        opacity: 0.5,
      },
    },
    {
      selector: 'edge[kind="co-occurrence"]',
      style: {
        width: 'mapData(weight, 1, 50, 1, 6)',
        'line-color': tokens.accent,
        opacity: 0.7,
        'curve-style': 'bezier',
      },
    },
    {
      selector: ':selected',
      style: {
        'border-width': 3,
        'border-color': tokens.accent,
      },
    },
  ] as unknown as cytoscape.StylesheetStyle[]
  return styles
}

