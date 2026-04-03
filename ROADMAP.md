# Roadmap

This roadmap reflects what it takes to fulfill the mission: get science in front of more people, keep them there, and build the foundation to do it sustainably. Priorities are ordered accordingly.

---

## Priority 1: Reach More People

These items directly determine whether someone can find and use the project at all.

### ~~1. Dataset search and filtering~~ ✅
Searchable, filterable dataset browser with keyword search, category and sub-category navigation, expandable cards with thumbnails.

### ~~2. Accessibility — screen reader support~~ ✅
Legend modal now has `role="dialog"`, `aria-modal`, focus management, and focus restore. Browse card keywords are keyboard-accessible with `role="button"`. "No results" messages are announced via `role="status"`. Legend alt text is dataset-specific.

### ~~3. Mobile HLS adaptive quality~~ ✅
ABR now selects the best stream for the device and network. Mobile is capped by resolution but no longer pinned to the lowest quality.

---

## Priority 2: Keep Them Engaged

Once someone arrives, these items determine whether they stay and learn.

### ~~4. Better loading states and transitions~~ ✅
Smooth fade-out transitions, granular progress indicators, and download progress reporting are now in place.

### ~~5. Persistent error messages~~ ✅
Error messages now stay visible until the user explicitly dismisses them via a close button.

### ~~6. Category-based browsing~~ ✅
Full category and sub-category navigation in the browse panel.

---

## Priority 3: Code Health for Velocity

Sustainable progress requires a codebase that doesn't slow us down.

### ~~7. Break up large files~~ ✅
Globe rendering is now handled by `mapRenderer.ts` (MapLibre GL JS) and `earthTileLayer.ts` (custom WebGL2 layer). Dataset loading in `datasetLoader.ts`. Playback controls extracted to `ui/playbackController.ts`. Browse UI extracted to `ui/browseUI.ts`.

### ~~8. Test coverage for orchestration logic~~ ✅
`main.test.ts` and test files for all major modules are in place.

### ~~9. Replace magic numbers with named constants~~ ✅
Named constants throughout — `main.ts`, `mapRenderer.ts`, `earthTileLayer.ts`, `playbackController.ts`, `browseUI.ts`.

### ~~10. Log level control~~ ✅
All 28 console calls now route through a `logger` utility with level gating (debug/info/warn/error/silent). Dev builds default to 'info', production to 'warn'. Override at runtime via `window.__LOG_LEVEL__`.

### ~~11. Debounce the window resize handler~~ ✅
The resize handler is now debounced (150 ms) to reduce unnecessary recalculations during drag-resize.

---

## Polish

Small things that affect the quality of the experience.

- ~~**Fix sphere rotation inertia between dataset switches**~~ ✅ — resolved by migration to MapLibre (built-in inertia handling).
- **Make related datasets in the info panel linkable** — if we're showing related content, it should be navigable.
- **Show date ranges for image datasets** — not just start dates; users should know the full temporal extent of what they're viewing.
- ~~**Remove `videoFrameExtractor.ts`**~~ ✅ — removed.
- **Fix Vimeo URL regex** — currently fails on URLs with query parameters.

---

## Longer Term

These items expand who the project can reach beyond its current assumptions.

### Offline and low-connectivity support
Many classrooms — and much of the world — don't have reliable broadband. Offline-capable modes or graceful low-bandwidth fallbacks would make the project genuinely usable in the contexts where environmental literacy matters most: rural schools, developing regions, places where a Science on a Sphere installation will never exist.

### Embeddability
Educators should be able to drop a single dataset view into their own site with one line of HTML. An embeddable iframe mode would let the project spread through the tools teachers already use, rather than asking them to send students to a separate URL.

---

*The project exists because the inspiration that Science on a Sphere creates shouldn't be limited by where you happen to be standing. This roadmap is about closing the remaining gaps.*
