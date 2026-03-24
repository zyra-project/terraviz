# Docent Chat Interaction Loop — Optimization Plan

## Current Architecture (post-optimization)

The docent chat follows this flow:

1. User types a message → `chatUI.ts` (`handleSend`)
2. `docentService.ts` (`processMessage`) runs the local engine first for instant actions, builds a **turn-aware** system prompt via `docentContext.ts` (full catalog with categories on turn 0, compact ID-only lookup on follow-ups), and streams LLM text via `llmProvider.ts`
3. `docentEngine.ts` (local intent parsing + dataset scoring) runs every turn and surfaces actions immediately; also used as text fallback if the LLM fails or is disabled
4. `llmProvider.ts` streams text deltas and tool calls as they arrive from the LLM
5. `chatUI.ts` renders text deltas and action cards incrementally — **local actions appear before the LLM finishes streaming**
6. History is stored as a compact summary of older turns plus the most recent 3 exchanges, rather than a naive 20-message slice

**Remaining optimization opportunities**: the first turn still pays the full catalog cost, and there is room for further coordination between LLM tool calls and local actions (e.g., speculative local text with LLM override).

---

## Phase 1: Dataset Catalog Deduplication

**Goal**: Stop packing the full dataset lookup table into the system prompt on every request.

### 1.1 — Turn-aware system prompt in `docentContext.ts`

New function `buildSystemPromptForTurn(datasets, currentDataset, turnIndex)`:

- **Turn 0**: Include full `buildDatasetLookup()` + `buildCategorySummary()` (as today)
- **Turn ≥ 1**: Replace with a compact reminder — `"Refer to the dataset catalog provided in the first message. {N} datasets available."` — plus only `buildCurrentDatasetContext()` and a short category summary

Keep `buildSystemPrompt()` as a backward-compatible wrapper calling `buildSystemPromptForTurn(..., 0)`.

**Files**: `src/services/docentContext.ts`, `src/services/docentService.ts`

### 1.2 — Intent-based cluster pre-filtering (optional)

When `parseIntent(input)` yields a clear category (e.g., `{ type: 'category', category: 'ocean' }`), pass only matching datasets into the lookup section — reducing ~80 lines to ~10-15.

New `buildFilteredDatasetLookup(datasets, intent)` using `findByCategory` or `searchDatasets`.

**Files**: `src/services/docentContext.ts`, `src/services/docentService.ts`

### 1.3 — Tests

- `docentContext.test.ts` — catalog present on turn 0, absent on turn ≥ 1
- `docentService.test.ts` — system prompt differs between first and subsequent turns

**Token savings**: ~2,000–3,000 tokens per follow-up turn. Over a 10-turn conversation: ~20,000–25,000 input tokens saved.

---

## Phase 2: Auto-Load High-Confidence Results

**Goal**: When scoring returns a single dominant match, load it automatically — no extra click needed.

### 2.1 — Auto-load evaluation in `docentEngine.ts`

```
AUTO_LOAD_THRESHOLD = 0.7
AUTO_LOAD_GAP = 0.25   // gap between #1 and #2
```

New `evaluateAutoLoad(results)` → `{ autoLoad: Dataset | null, alternatives: Dataset[] }`:
- Auto-load if `results[0].score >= 0.7` and either it's the only result or the gap to #2 exceeds 0.25

### 2.2 — New stream chunk type in `docentService.ts`

```typescript
| { type: 'auto-load'; action: ChatAction; alternatives: ChatAction[] }
```

Yield immediately after local engine scoring, before the LLM stream.

### 2.3 — UI handling in `chatUI.ts`

On `auto-load` chunk:
1. Call `callbacks.onLoadDataset(action.datasetId)` immediately
2. Set docent text to `"I've loaded **{title}** onto the globe."`
3. Show alternatives as action cards
4. Let LLM text continue streaming to supplement (e.g., "This shows sea surface temperatures…")

### 2.4 — Tests

- `docentEngine.test.ts` — high-confidence single match, close matches, no matches
- `docentService.test.ts` — `auto-load` chunks yielded when appropriate
- `chatUI.test.ts` — auto-load triggers `onLoadDataset`

---

## Phase 3: Immediate Action Cards from Local Engine

**Goal**: Show clickable dataset suggestions instantly while the LLM is still streaming text.

### 3.1 — Run local scoring upfront in `docentService.ts`

Before starting the LLM stream:

```typescript
const intent = parseIntent(input)
const localResponse = generateResponse(intent, datasets, currentDataset)
if (localResponse.actions) {
  for (const action of localResponse.actions) {
    yield { type: 'action', action }
    yieldedIds.add(action.datasetId)
  }
}
// Then iterate LLM stream...
```

### 3.2 — Deduplicate LLM tool calls

Track yielded dataset IDs in a `Set<string>`. When the LLM later emits a `tool_call` for a dataset already yielded, skip it.

### 3.3 — Provisional styling (optional polish)

Mark pre-LLM action cards with a `provisional` CSS class; remove once the LLM confirms or the stream finishes.

**Files**: `src/services/docentService.ts`, `src/ui/chatUI.ts`, chat CSS

### 3.4 — Tests

- Verify action chunks arrive before the first LLM delta
- Verify deduplication: local yields `TEST_001`, LLM also emits `TEST_001` → only one action

---

## Phase 4: Hybrid Local+LLM Parallel Execution

**Goal**: Combine the local engine's speed with the LLM's fluency. Show results immediately, narrate them as tokens arrive.

### 4.1 — Refactor `processMessage` into a parallel orchestrator

```
Current:   LLM stream → (if fails) → local fallback
Proposed:  Local engine (instant) → yield actions → LLM stream → deduplicate
```

This is architecturally simple: `streamChat` is an async generator that doesn't block until iterated, and the local engine is synchronous. Run local first (microseconds), yield results, then iterate the LLM stream.

### 4.2 — Optional: Speculative local text with LLM override

Yield local engine's text as a `provisional-text` chunk, then replace with the LLM's richer text on the first `delta`. Requires a new chunk type and UI crossfade logic.

```typescript
| { type: 'provisional-text'; text: string }
```

### 4.3 — Tests

- With LLM enabled + local results: actions arrive before first LLM delta
- Deduplication works
- Fallback still works when LLM fails

---

## Phase 5: Smarter History Management

**Goal**: Replace the naive 20-message window with compressed history.

### 5.1 — History compression strategy

New `buildCompressedHistory(messages, currentDataset)` → `LLMMessage[]`:

1. Keep the **last 3 exchanges** (6 messages) as full text
2. For older messages, generate a **summary block** extracting:
   - Topics discussed (via `parseIntent` on user messages)
   - Datasets loaded (from `ChatAction` data in docent messages)
   - Key questions asked
3. Format: `"[Conversation summary: User asked about hurricanes and ocean temps. Datasets loaded: Hurricane Tracks, Sea Surface Temperature.]"`

### 5.2 — Summary extraction helper

`summarizeOlderMessages(messages)` — purely local, no LLM call needed:
- User messages → first 50 chars or parsed intent type
- Docent messages → loaded dataset titles from `msg.actions`

### 5.3 — Wire into `docentService.ts`

Replace `buildMessageHistory(history)` with `buildCompressedHistory(history, currentDataset)`.

### 5.4 — Adjust safety cap

Change `MAX_HISTORY_MESSAGES` from 20 to 50 (or remove) — compression handles the token budget. The raw `messages` array in `chatUI.ts` still stores everything for display.

### 5.5 — Tests

- < 6 messages → no summarization
- 20+ messages → older ones summarized, last 6 verbatim
- Messages with actions → dataset titles appear in summary

**Token savings**: ~2,000 tokens → ~800 tokens. ~60% reduction on history.

---

## Implementation Sequencing

| Phase | Depends On | Effort | Impact |
|-------|-----------|--------|--------|
| 1 — Catalog Dedup | None | Low | High token savings |
| 5 — History Mgmt | None | Medium | High token savings |
| 3 — Immediate Actions | None | Low | High UX improvement |
| 4 — Hybrid Parallel | Phase 3 | Medium | High UX improvement |
| 2 — Auto-Load | Phase 3 or 4 | Medium | Medium UX improvement |

**Recommended order**: Phases 1 and 5 in parallel (both touch `docentContext.ts` but different functions). Then Phase 3 → Phase 4 → Phase 2.

---

## Architectural Notes

- **Backward compatibility**: `processMessage` signature gains optional params; `DocentStreamChunk` is extended with new variants. Existing consumers ignore unknown types.
- **Session persistence**: Compression is LLM-only, not display. No changes to `sessionStorage` logic.
- **No new dependencies**: All changes use existing patterns and exports.

### Critical Files

| File | Phases |
|------|--------|
| `src/services/docentService.ts` | All 5 — central orchestrator |
| `src/services/docentContext.ts` | 1, 5 — prompt building + history compression |
| `src/services/docentEngine.ts` | 2, 3, 4 — local scoring + auto-load |
| `src/ui/chatUI.ts` | 2, 3, 4 — new chunk handlers |
| `src/types/index.ts` | 2 — optional `autoLoaded` field on `ChatAction` |
