# Docent Chat — UX Improvement Plan

**Source research**: Nielsen Norman Group — [Site AI Chatbot Usability](https://www.nngroup.com/articles/site-ai-chatbot/)

This plan addresses gaps between NNGroup's chatbot usability findings and the current Digital Docent implementation. The technical optimization plan (`DOCENT_OPTIMIZATION_PLAN.md`) covers token efficiency and response speed; this plan covers discoverability, trust, and contextual relevance.

---

## What the Research Found

NNGroup identified five root causes of chatbot failure on websites:

1. **Discoverability** — Icon-only triggers blend in; users don't notice them.
2. **Low initial expectations** — Prior bad chatbot experiences create skepticism before the first message.
3. **Vague value proposition** — Generic openings like "find any info you need" don't communicate what makes this tool useful.
4. **Misaligned scope** — Chatbots offering features users don't seek on that site are ignored.
5. **Cognitive load** — Conversational interfaces force users to hold information in working memory that browse/filter UIs let them scan visually.

NNGroup found chatbots succeed when they answer **complex, multivariate questions** on detail pages — exactly the use case the Digital Docent is designed for.

---

## Current Strengths (Do Not Regress)

- **Narrow, domain-locked scope** — Docent stays within Earth science datasets. NNGroup explicitly recommends this.
- **Inline action buttons** — Converting `<<LOAD:ID>>` markers to buttons reduces the working-memory burden NNGroup flagged.
- **Welcome state with suggestions** — Provides entry points for new users.
- **Hybrid local + LLM fallback** — Fast responses regardless of connectivity.
- **`explain-current` intent** — Can discuss the currently loaded dataset, which aligns with NNGroup's finding that detail-page chatbots provide the most value.

---

## Improvement Areas

### 1 — Trigger Discoverability

**Problem**: The `#chat-trigger` is an icon-only floating button. NNGroup's top finding is that users simply don't notice these.

**Goal**: Make the trigger visible and communicative without being intrusive.

#### 1.1 — Add a text label to the trigger

Show "Ask the Docent" beside the speech-bubble icon. After the user has opened the panel once, collapse to icon-only (persist state in `localStorage`).

```
Before: [💬]
After:  [💬 Ask the Docent]   (collapses to [💬] after first open)
```

**Files**: `index.html` (trigger markup), chat CSS, `src/ui/chatUI.ts` (`initChatUI` — set collapsed class if `localStorage` flag is set)

#### 1.2 — Animate the trigger on first load

On the user's first visit (no `localStorage` flag), play a subtle pulse or slide-in animation on `#chat-trigger` to draw attention. One-time only.

**Files**: chat CSS, `src/ui/chatUI.ts`

---

### 2 — Value Proposition in the Welcome State

**Problem**: The welcome message and suggestion buttons are generic. Users arrive skeptical from previous chatbot experiences and need an immediate reason to try this one.

**Goal**: Immediately differentiate the Docent from both a generic chatbot and the browse panel.

#### 2.1 — Rewrite the welcome message

Replace any vague opener with copy that:
- Names what the Docent does specifically
- Explains what makes it different from browsing
- Sets appropriate expectations

**Proposed copy:**

> **I'm the Digital Docent** — I help you find the right dataset when you have a specific question.
>
> *Browse the catalog when you want to compare options. Ask me when you have something in mind — like "what shows coral bleaching?" or "I need ocean temperature data for the Atlantic."*

#### 2.2 — Make suggestion buttons domain-specific

Replace generic suggestions with examples that demonstrate the Docent's unique strengths — multivariate and context-dependent questions that browse can't answer well.

| Current (example) | Proposed |
|---|---|
| "What can you show me?" | "What should I use to study sea level rise?" |
| "Show me datasets" | "Which datasets cover the 2010s?" |
| "Help me find something" | "Explain what NDVI measures" |
| "What's on the globe?" | "Show me something related to hurricanes" |

**Files**: `index.html` (welcome message markup and suggestion buttons)

---

### 3 — Contextual Entry Point on Dataset Load

**Problem**: The chat panel is always-floating and always generic. NNGroup's highest-value chatbot scenario is answering questions *about the item currently in front of the user* — i.e., on a detail page.

**Goal**: Surface a contextual prompt when a dataset is loaded onto the globe.

#### 3.1 — "Ask about this dataset" prompt

When `notifyDatasetChanged()` is called with a new dataset, display a transient prompt near the dataset info panel or info button:

```
[ 💬 Ask the Docent about {Dataset Title} → ]
```

Clicking this:
1. Opens the chat panel (if closed)
2. Pre-fills the input with `"Tell me about {Dataset Title}"`
3. Auto-submits (or leaves it pre-filled for the user to send)

The prompt auto-dismisses after ~8 seconds or when the chat panel is opened.

#### 3.2 — Wiring

`notifyDatasetChanged()` in `chatUI.ts` already receives the current dataset. Add a call to a new `showDatasetPrompt(dataset)` function that injects the transient element near `#info-button` (or the info panel).

**Files**: `src/ui/chatUI.ts`, `index.html`, chat CSS

---

### 4 — Auto-Load Transparency

**Problem**: The auto-load feature (triggered when score ≥ 0.7 with a 0.25 gap to #2) silently loads a dataset. Users may not understand why something loaded or feel they've lost control.

**Goal**: Make auto-load feel confident and trustworthy, not arbitrary.

#### 4.1 — Explain the auto-load in the Docent's message

When auto-loading, the docent message should include a brief rationale before any LLM text follows:

> I've loaded **MODIS Sea Surface Temperature** — that's your closest match. Here are some related options if you had something different in mind:

This follows NNGroup's finding that expert-guided actions build trust when explained.

#### 4.2 — Show alternatives immediately

Alternatives are already yielded as action cards. Ensure they render *before* the LLM streaming text completes so the user can course-correct immediately.

**Files**: `src/services/docentService.ts` (auto-load chunk text), `src/ui/chatUI.ts` (rendering order)

---

### 5 — Complement Browse, Don't Compete With It

**Problem**: Both chat and the browse panel surface datasets. Without clear framing, users may not know which to use and may distrust the one they chose.

**Goal**: Create clear handoffs between the two interfaces.

#### 5.1 — Offer browse from chat when results are list-like

When the docent returns 3+ dataset results (a category search or broad query), add a footer prompt below the action cards:

> *Want to compare these side by side? [Open in Browse →]*

Clicking it opens the browse panel with the relevant category or search pre-applied.

#### 5.2 — Offer chat from browse for exploratory queries

In the browse panel, below the search input, add a passive hint for queries that return many or zero results:

> *Not sure what you need? [Ask the Docent →]*

This activates the chat panel and passes the current search term as a pre-filled message.

**Files**: `src/ui/chatUI.ts` (footer prompt on multi-result responses), `src/ui/browseUI.ts` (hint below search input)

---

## Implementation Sequencing

| Item | Effort | Impact | Depends On |
|------|--------|--------|------------|
| 2.1 — Rewrite welcome message | Low | High (first impression) | None |
| 2.2 — Domain-specific suggestion buttons | Low | High (demonstrates value) | None |
| 1.1 — Trigger label | Low | High (discoverability) | None |
| 4.1 — Auto-load rationale text | Low | Medium (trust) | None |
| 3.1 — Contextual dataset prompt | Medium | High (NNGroup's top success pattern) | None |
| 5.1 — Browse handoff from chat | Medium | Medium (reduces confusion) | None |
| 5.2 — Chat handoff from browse | Medium | Medium (reduces confusion) | None |
| 1.2 — First-visit trigger animation | Low | Low (nice to have) | 1.1 |

**Recommended order**: Items 2.1, 2.2, and 1.1 are copy/markup changes with no logic involved — ship together as a single pass. Then 4.1 (one-line text change in `docentService.ts`). Then 3.1 (new UI element with wiring). Then 5.1 and 5.2 together.

---

## Success Signals

Since there is no analytics instrumentation today, success is observable through:

- Users sending a first message without prompting (welcome state effectiveness)
- Users clicking "Ask about this dataset" contextual prompts (feature adoption)
- Users clicking "Open in Browse" from chat (handoff working)
- Absence of confusion questions like "what can you do?" in chat logs (value proposition clarity)

Adding lightweight event logging (e.g., which suggestion buttons are clicked, how often the contextual prompt is used) would make future iteration data-driven rather than qualitative.

---

## Relationship to Other Plans

- **`DOCENT_OPTIMIZATION_PLAN.md`** — Covers token efficiency and parallel LLM/local execution. The auto-load transparency improvement (Section 4 above) builds on the `auto-load` chunk type defined in Phase 2 of that plan.
- **`ROADMAP.md`** — These items belong under Priority 2 (Keep Them Engaged). The contextual dataset prompt (Section 3) could be listed there once scoped.
