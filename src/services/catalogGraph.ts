/**
 * Catalog Graph view — pure transform from a filtered catalog to a
 * node/edge graph for cytoscape.js.
 *
 * Phase 4 §6.7 of `docs/WEB_CATALOG_FEATURES_PLAN.md`. The Graph
 * view in `src/ui/catalogGraphUI.ts` consumes the result. The same
 * predicate engine that drives the chip rail (`datasetFilter.ts`)
 * filters the dataset set first, so the graph always reflects what
 * the user has narrowed to.
 *
 * Pure module — no DOM, no fetch, no cytoscape import, no analytics.
 * Tests run without happy-dom.
 *
 * Node model (v1, §6.7 + design Q&A):
 *
 *  - `facet-value` — one per `(facet, value)` pair from the visible
 *    multi-select facets. v1 surfaces Category (tags) and Format
 *    buckets; range and boolean facets stay chip-rail-only.
 *  - `keyword` — one per `enriched.keywords` value. Surfaced only
 *    when the caller asks for it (`options.expandedKeywordParents`),
 *    matching the §6.7 "expand on demand" affordance.
 *  - `dataset` — one per row in the post-filter set. Always rendered.
 *
 * Edge model:
 *
 *  - `membership` — `dataset ↔ facet-value` and (when keywords are
 *    expanded) `dataset ↔ keyword`. Drives the radial cluster
 *    layout.
 *  - `co-occurrence` — `facet-value ↔ facet-value` across DIFFERENT
 *    facets only (Category ↔ Format). Weight is the number of
 *    datasets carrying both. Within-facet edges aren't emitted —
 *    "Water co-occurs with Land" isn't a useful structural signal
 *    in this catalog.
 *
 * Scale management:
 *
 *  - `options.minEdgeWeight` (default 2) hides singleton
 *    co-occurrence edges — there are many in the long tail and
 *    they clutter the view without adding information.
 *  - Keywords stay collapsed by default; the UI surfaces an
 *    "expand" affordance per facet-value cluster.
 */

import type { Dataset } from '../types'
import {
  BASELINE_RESOLVERS,
  PERIOD_RESOLVER,
  filterDatasets,
  formatToBucket,
  mergeFilterStates,
  parseSearchQuery,
  type FacetResolver,
  type FilterState,
  type FormatBucket,
} from './datasetFilter'

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/**
 * Facet groups from §6.1 that own a colour token. Keyed by string
 * so federation peer facets (§1.4) can register additional groups
 * without a type change.
 */
export type FacetGroup =
  | 'category-content'
  | 'format-medium'
  | 'time'
  | 'quality-availability'

/** Map from facet name → its display group. Single source of truth
 *  shared with `browseUI.ts`'s `SECTION_FACETS` constant; if a new
 *  baseline facet lands, add it here and in `SECTION_FACETS` in
 *  the same commit. */
export const FACET_TO_GROUP: Readonly<Record<string, FacetGroup>> = {
  category: 'category-content',
  keyword: 'category-content',
  format: 'format-medium',
  dateAdded: 'time',
  dataCoverageYear: 'time',
  hasCaptions: 'quality-availability',
  hasTour: 'quality-availability',
  includeSos: 'quality-availability',
}

/**
 * The four user-facing Format buckets, in chip-rail display order
 * (Other last). Mirrors `FORMAT_BUCKETS` in `browseUI.ts` — both
 * lists exist because the chip rail consumes a localised label
 * pair while the graph consumes raw bucket strings, but the
 * ordering must stay in lockstep so chip/graph value sets agree.
 */
const FORMAT_BUCKETS: readonly FormatBucket[] = ['video', 'image', 'tour', 'other']

/**
 * Shared by all node variants. A node carries its identity
 * (`id`), its visual classification (`kind`, `group`), and a
 * `datasetCount` so the UI can render tooltips ("Atmosphere — 56
 * datasets") without re-traversing the dataset set.
 */
interface GraphNodeBase {
  id: string
  kind: 'facet-value' | 'keyword' | 'dataset'
  /** Display group — drives colour token + visual grouping. `null`
   *  for dataset nodes (they're neutral grey per §6.7). */
  group: FacetGroup | null
  /** Localisable display label. Facet-value labels are the raw
   *  value (`'Water'`, `'video'`); the UI maps `format` bucket
   *  values to i18n strings before rendering. */
  label: string
  /** Number of post-filter datasets the node is attached to. For
   *  facet-value / keyword nodes this is the membership count; for
   *  dataset nodes it's always 1. */
  datasetCount: number
}

export interface FacetValueNode extends GraphNodeBase {
  kind: 'facet-value'
  facet: string
  value: string
}

export interface KeywordNode extends GraphNodeBase {
  kind: 'keyword'
  value: string
  /** Facet-value node ID this keyword was expanded under. Drives
   *  the hub-and-spoke layout — keywords cluster radially around
   *  their parent. */
  parentFacetValueId: string
}

export interface DatasetNode extends GraphNodeBase {
  kind: 'dataset'
  datasetId: string
}

export type GraphNode = FacetValueNode | KeywordNode | DatasetNode

export interface GraphEdge {
  id: string
  kind: 'membership' | 'co-occurrence'
  source: string
  target: string
  /** Membership edges are always weight 1. Co-occurrence edges
   *  carry the number of datasets containing both endpoints. */
  weight: number
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Total dataset count after filtering — useful for "showing
   *  N of M" callouts in the UI without recomputing. */
  filteredDatasetCount: number
}

export interface BuildGraphOptions {
  /** Hide co-occurrence edges with weight strictly less than this
   *  value. Default 2 — singleton co-occurrences are long-tail
   *  noise. Set to 1 to surface them anyway. Membership edges are
   *  unaffected. */
  minEdgeWeight?: number
  /**
   * Set of facet-value node IDs whose keyword children should be
   * surfaced. Absent / empty Set keeps all keywords collapsed
   * under their parent facet-value (the §6.7 default).
   *
   * IDs are the node `id` strings (e.g. `'facet:category:Water'`)
   * not the raw values — so the caller never has to reason about
   * the encoding.
   */
  expandedKeywordParents?: ReadonlySet<string>
  /**
   * Auto-expand the top-N most-populated keywords under EVERY
   * Category facet-value cluster, in addition to anything listed
   * in `expandedKeywordParents`.
   *
   * Service-level default is `0` (off) — callers that don't pass
   * the option get the original §6.7 "collapse keywords by
   * default" behaviour. The shipped Graph view UI overrides this
   * to `6` per PR #137 feedback, which moved the surface closer
   * to the GSL Depot Explorer reference (each Category hub
   * auto-radiates its top keywords so the user can skim
   * co-occurrence structure without clicking into every cluster).
   *
   * Capped per-cluster (not globally) so a sparsely-populated
   * Category still surfaces its top few keywords. Keywords whose
   * normalised value matches the parent's tag are suppressed
   * (the tag-fallback path in the keyword resolver duplicates the
   * tag into the keyword set; we don't want "Water" radiating
   * "Water" back to itself).
   */
  autoExpandKeywordsPerCluster?: number
  /**
   * Render Format-bucket facet-value nodes (video / image /
   * tour / other) as first-class clusters with co-occurrence
   * edges to Category. Default `false` — feedback during PR #137
   * was that Format clutters the discovery view without adding
   * a question the user is asking; the toggle is opt-in via a
   * graph-toolbar checkbox.
   *
   * When `false`, Format is omitted entirely from the graph;
   * the chip rail remains the surface for Format filtering.
   * Co-occurrence edges (Category ↔ Format) follow the toggle —
   * they're emitted only when Format nodes are too.
   */
  includeFormatNodes?: boolean
  /** Resolvers passed to `filterDatasets` — defaults to the §6.1
   *  baseline plus the search-only `period:` resolver, matching
   *  what `browseUI.ts` uses. */
  resolvers?: Readonly<Record<string, FacetResolver>>
}

// ---------------------------------------------------------------------------
// Node ID helpers — exported so the UI can derive IDs for click /
// expand handlers without re-encoding the conventions here.
// ---------------------------------------------------------------------------

/** Stable ID for a facet-value node. `value` is included verbatim
 *  so it round-trips through cytoscape's selectors without escaping. */
export function facetValueNodeId(facet: string, value: string): string {
  return `facet:${facet}:${value}`
}

/** Stable ID for a keyword node. Keywords share a global namespace
 *  rather than nesting under a parent — a keyword used by datasets
 *  in multiple Category clusters is one node connecting all of
 *  them, not one per cluster. */
export function keywordNodeId(value: string): string {
  return `keyword:${value.toLowerCase()}`
}

/** Stable ID for a dataset node. */
export function datasetNodeId(datasetId: string): string {
  return `dataset:${datasetId}`
}

/** Stable ID for a membership / co-occurrence edge. Edge IDs are
 *  ordered (source < target lexicographically) so an undirected
 *  edge from A↔B has the same ID regardless of traversal order. */
function edgeId(kind: GraphEdge['kind'], a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return `${kind}:${lo}--${hi}`
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Default resolvers used when the caller doesn't supply its own —
 * matches `browseUI.ts` so the graph view's pre-filter is identical
 * to the card grid's.
 */
const DEFAULT_RESOLVERS = { ...BASELINE_RESOLVERS, period: PERIOD_RESOLVER }

/**
 * Build the graph from a catalog + filter state + free-text query.
 *
 * The query is parsed via `parseSearchQuery` so prefix tokens
 * (`category:Water`) drive the graph identically to the chip rail —
 * the user can pivot between Cards and Graph without the filter
 * surface shifting under them.
 *
 * @param datasets   Full catalog. Hidden datasets are excluded by
 *                   `filterDatasets` automatically.
 * @param filterState Chip-rail state from `browseUI.ts`.
 * @param searchQuery Raw search-box string. Defaults to `''`.
 * @param options    Edge-weight floor + keyword expansion.
 */
export function buildGraph(
  datasets: readonly Dataset[],
  filterState: FilterState,
  searchQuery: string = '',
  options: BuildGraphOptions = {},
): Graph {
  const minEdgeWeight = Math.max(1, options.minEdgeWeight ?? 2)
  const expanded = options.expandedKeywordParents ?? EMPTY_SET
  const autoExpandPerCluster = Math.max(0, options.autoExpandKeywordsPerCluster ?? 0)
  const includeFormatNodes = options.includeFormatNodes ?? false
  const resolvers = options.resolvers ?? DEFAULT_RESOLVERS

  const parsed = parseSearchQuery(searchQuery)
  const effectiveState = mergeFilterStates(filterState, parsed.prefixes)
  const filtered = filterDatasets(datasets, effectiveState, parsed.freeText, resolvers)

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const nodeIndex = new Map<string, GraphNode>()

  const addNode = (node: GraphNode): void => {
    if (nodeIndex.has(node.id)) return
    nodeIndex.set(node.id, node)
    nodes.push(node)
  }

  // 1. Dataset nodes — always one per filtered row, neutral group.
  for (const dataset of filtered) {
    addNode({
      id: datasetNodeId(dataset.id),
      kind: 'dataset',
      group: null,
      label: dataset.title,
      datasetCount: 1,
      datasetId: dataset.id,
    })
  }

  // 2. Tally facet-value memberships across the filtered set in a
  //    single pass. `categoryMembers` and `formatMembers` map a
  //    facet-value's node ID to the set of dataset IDs that carry
  //    it; the cardinality becomes `datasetCount`, and the pair-
  //    wise overlap drives co-occurrence weight.
  const categoryMembers = new Map<string, Set<string>>()
  const formatMembers = new Map<string, Set<string>>()
  const keywordMembers = new Map<string, Set<string>>()
  // Keywords are deduplicated case-insensitively (`'Hurricane'` and
  // `'hurricane'` collapse to one node) — `keywordDisplay` retains
  // the first-seen casing so the node label still reads naturally.
  const keywordDisplay = new Map<string, string>()

  for (const dataset of filtered) {
    const datasetId = dataset.id
    for (const tag of dataset.tags ?? []) {
      const nodeId = facetValueNodeId('category', tag)
      let members = categoryMembers.get(nodeId)
      if (!members) {
        members = new Set()
        categoryMembers.set(nodeId, members)
      }
      members.add(datasetId)
    }

    const bucket = formatToBucket(dataset.format)
    if (FORMAT_BUCKETS.includes(bucket)) {
      const nodeId = facetValueNodeId('format', bucket)
      let members = formatMembers.get(nodeId)
      if (!members) {
        members = new Set()
        formatMembers.set(nodeId, members)
      }
      members.add(datasetId)
    }

    // Keywords — collected for every dataset so co-occurrence /
    // expand-on-demand work even without expansion enabled today.
    // The set is small per dataset (~10 keywords); the global
    // dedupe via `keywordMembers` keeps the cost bounded.
    const enrichedKws = dataset.enriched?.keywords
    const haystack = enrichedKws && enrichedKws.length > 0
      ? enrichedKws
      : (dataset.tags ?? [])
    for (const kw of haystack) {
      if (!kw) continue
      const nodeId = keywordNodeId(kw)
      let members = keywordMembers.get(nodeId)
      if (!members) {
        members = new Set()
        keywordMembers.set(nodeId, members)
        keywordDisplay.set(nodeId, kw)
      }
      members.add(datasetId)
    }
  }

  // 3. Emit facet-value nodes (Category + Format) and their
  //    membership edges.
  const emitFacetValueNodes = (
    facet: 'category' | 'format',
    members: Map<string, Set<string>>,
    valueFromId: (id: string) => string,
  ): void => {
    // Sort by membership count desc, then value ascending for
    // stable layout — cytoscape's incremental layout is sensitive
    // to insertion order on the first run.
    const entries = Array.from(members.entries()).sort((a, b) => {
      const sizeDiff = b[1].size - a[1].size
      if (sizeDiff !== 0) return sizeDiff
      return valueFromId(a[0]).localeCompare(valueFromId(b[0]))
    })
    for (const [nodeId, datasetIds] of entries) {
      const value = valueFromId(nodeId)
      addNode({
        id: nodeId,
        kind: 'facet-value',
        facet,
        value,
        group: FACET_TO_GROUP[facet] ?? null,
        label: value,
        datasetCount: datasetIds.size,
      })
      for (const datasetId of datasetIds) {
        const targetId = datasetNodeId(datasetId)
        edges.push({
          id: edgeId('membership', nodeId, targetId),
          kind: 'membership',
          source: nodeId,
          target: targetId,
          weight: 1,
        })
      }
    }
  }

  emitFacetValueNodes('category', categoryMembers, id => id.slice('facet:category:'.length))
  if (includeFormatNodes) {
    emitFacetValueNodes('format', formatMembers, id => id.slice('facet:format:'.length))
  }

  // 4. Resolve the full set of facet-value parents whose keywords
  //    should surface. The union is:
  //      a) explicit user-driven expansions (`expanded`), AND
  //      b) auto-expansions: top-N keywords by intra-cluster
  //         membership for EVERY Category facet-value, when
  //         `autoExpandKeywordsPerCluster > 0`.
  //
  //    Auto-expansion is per-cluster (not global) so a small
  //    Category still surfaces its few characteristic keywords.
  //    Format clusters aren't auto-expanded — when Format nodes
  //    are off (the default) they don't exist, and when they're
  //    on the user typically wants to read Category↔Format edge
  //    structure, not Format-keyword detail.
  const effectivelyExpanded = new Set<string>(expanded)
  const autoExpansionsPerParent = new Map<string, Set<string>>()
  if (autoExpandPerCluster > 0) {
    for (const [parentId, parentMembers] of categoryMembers) {
      const parentTag = parentId.slice('facet:category:'.length).toLowerCase()
      const scored: Array<{ keywordId: string; overlap: number; label: string }> = []
      for (const [keywordId, kwMembers] of keywordMembers) {
        // Suppress the tag-fallback echo — `keyword:water` next to
        // `facet:category:Water` is redundant. The keyword resolver
        // synthesises the tag into the keyword set when
        // `enriched.keywords` is missing, so the dedupe lives here.
        if (keywordId === `keyword:${parentTag}`) continue
        let overlap = 0
        const [small, large] = parentMembers.size <= kwMembers.size
          ? [parentMembers, kwMembers]
          : [kwMembers, parentMembers]
        for (const id of small) if (large.has(id)) overlap++
        if (overlap <= 0) continue
        scored.push({
          keywordId,
          overlap,
          label: keywordDisplay.get(keywordId) ?? keywordId,
        })
      }
      scored.sort((a, b) => {
        if (b.overlap !== a.overlap) return b.overlap - a.overlap
        return a.label.localeCompare(b.label)
      })
      const top = new Set(
        scored.slice(0, autoExpandPerCluster).map(s => s.keywordId),
      )
      autoExpansionsPerParent.set(parentId, top)
      if (top.size > 0) effectivelyExpanded.add(parentId)
    }
  }

  // 5. Keyword nodes — surfaced when at least one parent is
  //    "effectively expanded" (explicit user expansion or
  //    auto-expansion picked them as a top-N child). A keyword
  //    only connects to the parents that actually selected it,
  //    so auto-expansion doesn't accidentally pull every
  //    keyword into every cluster.
  if (effectivelyExpanded.size > 0) {
    const parentMembership = new Map<string, Set<string>>()
    for (const parentId of effectivelyExpanded) {
      const members = categoryMembers.get(parentId) ?? formatMembers.get(parentId)
      if (members) parentMembership.set(parentId, members)
    }

    for (const [keywordId, datasetIds] of keywordMembers) {
      // Find every parent whose membership intersects this keyword
      // AND whose expansion picked it. Two qualification paths:
      //   (a) parent is explicitly in `expanded` (user double-click)
      //       → ANY overlapping keyword qualifies under it
      //   (b) parent had auto-expansion run → only its top-N picks
      //       qualify (avoids 723 keywords flooding the canvas)
      // A keyword qualifying under both paths simply connects to
      // both parents — same global node, multiple parent links.
      const matchingParents: Array<{ parentId: string; overlap: Set<string> }> = []
      for (const [parentId, parentMembers] of parentMembership) {
        const autoPicks = autoExpansionsPerParent.get(parentId)
        const isExplicitParent = expanded.has(parentId)
        if (!isExplicitParent && (!autoPicks || !autoPicks.has(keywordId))) continue
        const overlap = new Set<string>()
        for (const id of datasetIds) {
          if (parentMembers.has(id)) overlap.add(id)
        }
        if (overlap.size > 0) matchingParents.push({ parentId, overlap })
      }
      if (matchingParents.length === 0) continue

      const firstParent = matchingParents[0].parentId
      const display = keywordDisplay.get(keywordId)
        ?? keywordId.slice('keyword:'.length)
      addNode({
        id: keywordId,
        kind: 'keyword',
        value: display,
        label: display,
        // Keywords inherit the hue of whichever parent surfaced
        // them first. When a keyword sits between Category and
        // Format clusters cytoscape will route the membership
        // edges to both anyway; the colour just keys the visual
        // cluster.
        group: nodeIndex.get(firstParent)?.group ?? null,
        datasetCount: datasetIds.size,
        parentFacetValueId: firstParent,
      })

      // Keyword ↔ dataset membership — only for datasets that are
      // both in the keyword's set AND in at least one expanded
      // parent. Restricting to the parent set keeps the visible
      // edge count proportional to the user's expansion choice;
      // expanding "Water" shouldn't pull in dataset-keyword edges
      // for datasets that aren't in Water.
      const visibleDatasets = new Set<string>()
      for (const { overlap } of matchingParents) {
        for (const id of overlap) visibleDatasets.add(id)
      }
      for (const datasetId of visibleDatasets) {
        const targetId = datasetNodeId(datasetId)
        edges.push({
          id: edgeId('membership', keywordId, targetId),
          kind: 'membership',
          source: keywordId,
          target: targetId,
          weight: 1,
        })
      }
    }
  }

  // 6. Co-occurrence edges — Category ↔ Format only. Within-facet
  //    co-occurrence isn't emitted (every dataset has exactly one
  //    Format bucket, so within-Format co-occurrence is always 0;
  //    within-Category co-occurrence is dominated by trivially-
  //    common combinations that crowd the layout). Skipped
  //    entirely when Format nodes aren't rendered — an edge to a
  //    non-existent node would dangle.
  if (includeFormatNodes) {
    for (const [catId, catMembers] of categoryMembers) {
      for (const [fmtId, fmtMembers] of formatMembers) {
        let overlap = 0
        // Iterate the smaller set for a cheaper intersection.
        const [small, large] = catMembers.size <= fmtMembers.size
          ? [catMembers, fmtMembers]
          : [fmtMembers, catMembers]
        for (const id of small) {
          if (large.has(id)) overlap++
        }
        if (overlap < minEdgeWeight) continue
        edges.push({
          id: edgeId('co-occurrence', catId, fmtId),
          kind: 'co-occurrence',
          source: catId,
          target: fmtId,
          weight: overlap,
        })
      }
    }
  }

  return { nodes, edges, filteredDatasetCount: filtered.length }
}

/** Internal empty-set sentinel so we don't allocate a fresh `Set`
 *  on every `buildGraph` call without an expansion. */
const EMPTY_SET: ReadonlySet<string> = new Set<string>()

// ---------------------------------------------------------------------------
// Convenience selectors — used by `catalogGraphUI.ts` for hover /
// tooltip rendering without re-walking the graph.
// ---------------------------------------------------------------------------

/**
 * Return the top-N co-occurring facet-value node IDs for a given
 * facet-value node, ordered by edge weight desc. Used by the hover
 * tooltip ("Top 3 co-occurring facets"). Ignores membership edges.
 * Returns at most `limit` neighbours; ties broken by neighbour ID.
 */
export function topCoOccurrences(
  graph: Graph,
  nodeId: string,
  limit: number = 3,
): Array<{ neighbourId: string; weight: number }> {
  const matches: Array<{ neighbourId: string; weight: number }> = []
  for (const edge of graph.edges) {
    if (edge.kind !== 'co-occurrence') continue
    if (edge.source === nodeId) {
      matches.push({ neighbourId: edge.target, weight: edge.weight })
    } else if (edge.target === nodeId) {
      matches.push({ neighbourId: edge.source, weight: edge.weight })
    }
  }
  matches.sort((a, b) => {
    const w = b.weight - a.weight
    if (w !== 0) return w
    return a.neighbourId.localeCompare(b.neighbourId)
  })
  return matches.slice(0, Math.max(0, limit))
}
