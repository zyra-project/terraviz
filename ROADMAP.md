# Roadmap

This roadmap reflects what it takes to fulfill the mission: get science in front of more people, keep them there, and build the foundation to do it sustainably. Priorities are ordered accordingly.

---

## Priority 1: Reach More People

These items directly determine whether someone can find and use the project at all.

### 1. Dataset search and filtering
NOAA's SOS catalog has 600+ datasets. Right now there is no way to discover them. We need a searchable, filterable interface — browsable by keyword and category — that appears when no `dataset=` URL parameter is specified. A student looking for "hurricanes" or "sea ice" should find something immediately, not face a blank sphere.

### 2. Accessibility overhaul
The project is for everyone. That means ARIA labels on all controls, full keyboard navigation, and screen reader support. None of this should be bolted on later — it belongs in the foundation.

### 3. Mobile HLS adaptive quality
We currently force the lowest quality stream on mobile. Devices and networks have improved; the viewer should adapt to actual bandwidth rather than assuming the worst. This directly affects the majority of users in the developing world and in classrooms where phones are the primary device.

---

## Priority 2: Keep Them Engaged

Once someone arrives, these items determine whether they stay and learn.

### 4. Better loading states and transitions
Switching datasets currently involves abrupt visual changes. Smoother transitions and clear loading indicators help users understand what's happening and reduce the sense that something is broken.

### 5. Persistent error messages
Error messages currently auto-dismiss after 5 seconds. Users shouldn't have to catch errors on a timer. Messages should stay visible until dismissed.

### 6. Category-based browsing
Oceans. Atmosphere. Weather events. Ice and sea level. Land use. Grouping datasets into meaningful categories helps users explore related content and understand the scope of what's available — turning a single visit into a deeper investigation.

---

## Priority 3: Code Health for Velocity

Sustainable progress requires a codebase that doesn't slow us down.

### 7. Break up large files
`sphereRenderer.ts` is 928 lines. `main.ts` is 651 lines. Both have grown past the point where they're easy to reason about. Splitting them into focused modules will make everything else on this list easier to ship.

### 8. Test coverage for orchestration logic
`main.ts` coordinates the core application flow and currently has no automated tests. Adding coverage here will catch regressions before they reach users.

### 9. Replace magic numbers with named constants
Scattered numeric literals make the code harder to read and modify safely. Named constants document intent.

### 10. Log level control
Production builds should not emit console logs. Adding log level control lets us keep useful debugging without exposing internals.

### 11. Debounce the window resize handler
The current handler fires on every resize event. Debouncing it reduces unnecessary recalculations and improves performance on resize-heavy interactions.

---

## Polish

Small things that affect the quality of the experience.

- **Fix sphere rotation inertia between dataset switches** — inertia should reset when a new dataset loads, not carry over from the previous one.
- **Make related datasets in the info panel linkable** — if we're showing related content, it should be navigable.
- **Show date ranges for image datasets** — not just start dates; users should know the full temporal extent of what they're viewing.
- **Remove `videoFrameExtractor.ts`** — dead code that adds noise and confusion.
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
