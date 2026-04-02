# CLAUDE.md

## Git

- All commits must be DCO signed-off. Use `git commit -s` (or `--signoff`) on every commit.

---

## Codebase Overview

TypeScript SPA built with Vite and Three.js. Deployed on Cloudflare Pages. No runtime framework — vanilla TS with a few focused libraries (Three.js, HLS.js).

### Key commands

```bash
npm run dev          # dev server (localhost:5173)
npm run build        # tsc + vite build
npm run type-check   # tsc --noEmit (must pass before committing)
npm run test         # vitest run
```

### Module map

| File | Responsibility |
|---|---|
| `src/main.ts` | App entry — boots MapLibre renderer, orchestrates dataset loading |
| `src/types/index.ts` | All shared types (`Dataset`, `ChatMessage`, `AppState`, `DocentConfig`…) |
| `src/services/mapRenderer.ts` | MapLibre GL JS globe — GIBS tiles, navigation, markers, terrain |
| `src/services/earthTileLayer.ts` | CustomLayerInterface — day/night blend, clouds, specular, sun, skybox |
| `src/services/dataService.ts` | Fetches SOS catalog, merges enriched metadata, 1-hour cache |
| `src/services/datasetLoader.ts` | Loads a dataset onto the globe (HLS or image); manages info panel |
| `src/services/hlsService.ts` | HLS.js wrapper — adaptive bitrate streaming via Vimeo proxy |
| `src/services/docentService.ts` | Orbit orchestrator — hybrid LLM + local engine |
| `src/services/docentContext.ts` | LLM system prompt builder, history compression, tool definition |
| `src/services/docentEngine.ts` | Local keyword-based fallback engine |
| `src/services/llmProvider.ts` | OpenAI-compatible SSE streaming client + `/models` fetch |
| `src/ui/chatUI.ts` | Orbit chat panel — rendering, settings, trigger positioning |
| `src/ui/browseUI.ts` | Dataset browse/search overlay |
| `src/ui/mapControlsUI.ts` | Map controls overlay — labels, boundaries, terrain toggles |
| `src/ui/playbackController.ts` | Playback transport controls + portrait-mobile positioning |

---

## Orbit — Digital Docent

Orbit is the AI chat assistant. Understanding its architecture is essential for working on the chat feature.

### Hybrid architecture

`docentService.processMessage()` runs two paths concurrently:

1. **Local engine** (`docentEngine.ts`) — instant keyword/intent matching, no network required, always available
2. **LLM stream** (`llmProvider.ts` → `docentContext.ts`) — streams from any OpenAI-compatible endpoint

If the LLM errors or is disabled, the local engine result is used as the response. When the LLM succeeds it is the sole source of dataset recommendations.

### Dataset loading from chat

The LLM is prompted to embed `<<LOAD:DATASET_ID>>` markers inline with its text. `docentService.extractActionsFromText()` parses these (plus bare `INTERNAL_...` IDs as a fallback for LLMs that ignore the marker instructions) into `action` stream chunks. `chatUI.ts` renders each action as an inline load button inside the message bubble — the `<<LOAD:...>>` syntax is never shown to the user.

The `load_dataset` function-calling tool is also supported for providers that prefer tool calls over inline markers.

### System prompt

`docentContext.buildSystemPromptForTurn()` is turn-aware:
- **Turn 0**: full catalog (ID | Title [Categories]) — more tokens, best for opening recommendations
- **Turn ≥1**: compact catalog (ID | Title only) to reduce per-turn cost

History is compressed: the last 3 exchanges are sent verbatim; older messages are summarised.

### LLM configuration

Stored in `localStorage` under `sos-docent-config`. Defaults:
- `apiUrl`: `/api` (Cloudflare proxy in production; override to a direct URL for local dev)
- `model`: `llama-3.1-70b` (populated from `/models` endpoint dropdown)
- `apiKey`: empty
- `enabled`: true

> On localhost the Cloudflare `/api` proxy is unavailable. The docent falls back to local engine automatically if the LLM is unreachable.

### Stream chunk types

`DocentStreamChunk` union (from `docentService.ts`):
- `delta` — text fragment to append to the current message
- `action` — load a dataset (renders as an inline button)
- `auto-load` — auto-loaded dataset with alternatives
- `done` — stream complete; `fallback: true` if local engine was used

---

## UI Layout & Panel Coordination

The UI is floating glass-surface overlays on a full-viewport WebGL canvas. See [STYLE_GUIDE.md](STYLE_GUIDE.md) for visual design rules.

### Panel mutual exclusion

- Expanding the **info panel** (dataset metadata) closes the chat panel via `closeChat()` in `datasetLoader.ts`
- Opening the **chat panel** collapses the info panel via DOM manipulation in `chatUI.openChat()`

### ResizeObserver-driven positioning

Two elements track the info panel height as it animates open:

- **Chat trigger** (`#chat-trigger`) — managed in `chatUI.updateTriggerForInfoPanel()`, wired in `wireEvents()`
- **Playback controls** (`#playback-controls`) — managed in `playbackController.initPlaybackPositioning()`, called from `main.ts`. Portrait mobile only (≤600px + portrait orientation). Resets to `'0.75rem'` (not `''`) because the element uses an inline style with no CSS fallback.

### Responsive breakpoints

| Breakpoint | Behaviour |
|---|---|
| `> 768px` | Desktop |
| `≤ 768px` | Mobile — panels slide from edges |
| `≤ 600px` + portrait | Portrait phone — browse card titles on own line; playback controls lift above info panel |

---

## Deployment

Cloudflare Pages. `functions/api/[[route]].ts` is a Cloudflare Function that proxies LLM API requests server-side so the API key is never in the client bundle.
