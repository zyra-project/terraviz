/**
 * Curated feed-preset catalog for the portal feeds page
 * (`docs/CURRENT_EVENTS_PLAN.md` §9).
 *
 * Editorial content, versioned in code (the same pattern as the
 * matcher's curated topic map): each entry is a reputable feed an
 * operator can add with one click, grouped by category — structured
 * hazard feeds first (geo+time built in), then science-org newsrooms,
 * then a small set of reputable general-news sections. Adding a preset
 * just prefills the connector-create call; the operator can edit or
 * remove it like any custom feed afterwards.
 *
 * Feed labels are proper names (organisations / products) and stay
 * untranslated; the one-line descriptions are i18n keys so translators
 * can localise the guidance.
 *
 * Every feed here is ingest-only provenance: headline + summary + link
 * land in the curator review queue as `proposed` events. Nothing
 * surfaces publicly without curator approval, which is what keeps a
 * broad catalog safe to offer.
 */

import type { MessageKey } from '../../i18n'

export interface FeedPreset {
  /** Stable slug — keys the description i18n entry. */
  id: string
  kind: 'eonet' | 'rss'
  /** Proper name of the org/feed. i18n-exempt: brand names. */
  label: string
  url: string
  category: FeedPresetCategory
  /** One-line why-this-feed shown on the gallery card. */
  descriptionKey: MessageKey
}

export const FEED_PRESET_CATEGORIES = ['hazards', 'science-news', 'news'] as const
export type FeedPresetCategory = (typeof FEED_PRESET_CATEGORIES)[number]

/* eslint-disable max-len */
export const FEED_PRESETS: readonly FeedPreset[] = [
  // ── Natural hazards — structured feeds with geometry + time built in ──
  {
    id: 'eonet',
    kind: 'eonet',
    label: 'NASA EONET', // i18n-exempt: proper name
    url: 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=14',
    category: 'hazards',
    descriptionKey: 'publisher.feeds.preset.eonet',
  },
  {
    id: 'usgs-quakes',
    kind: 'rss',
    label: 'USGS Earthquakes (M4.5+, past week)', // i18n-exempt: proper name
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.atom',
    category: 'hazards',
    descriptionKey: 'publisher.feeds.preset.usgsQuakes',
  },
  {
    id: 'gdacs',
    kind: 'rss',
    label: 'GDACS disaster alerts', // i18n-exempt: proper name
    url: 'https://www.gdacs.org/xml/rss.xml',
    category: 'hazards',
    descriptionKey: 'publisher.feeds.preset.gdacs',
  },
  {
    id: 'gvp-volcanic',
    kind: 'rss',
    label: 'Smithsonian GVP volcanic activity', // i18n-exempt: proper name
    url: 'https://volcano.si.edu/news/WeeklyVolcanoRSS.xml',
    category: 'hazards',
    descriptionKey: 'publisher.feeds.preset.gvp',
  },
  // ── Science-org newsrooms ─────────────────────────────────────────
  {
    id: 'nasa-earth-observatory',
    kind: 'rss',
    label: 'NASA Earth Observatory', // i18n-exempt: proper name
    url: 'https://earthobservatory.nasa.gov/feeds/earth-observatory.rss',
    category: 'science-news',
    descriptionKey: 'publisher.feeds.preset.nasaEo',
  },
  {
    id: 'nasa-news',
    kind: 'rss',
    label: 'NASA breaking news', // i18n-exempt: proper name
    url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss',
    category: 'science-news',
    descriptionKey: 'publisher.feeds.preset.nasaNews',
  },
  {
    id: 'esa-earth',
    kind: 'rss',
    label: 'ESA Observing the Earth', // i18n-exempt: proper name
    url: 'https://www.esa.int/rssfeed/Our_Activities/Observing_the_Earth',
    category: 'science-news',
    descriptionKey: 'publisher.feeds.preset.esaEarth',
  },
  {
    id: 'physorg-earth',
    kind: 'rss',
    label: 'Phys.org Earth news', // i18n-exempt: proper name
    url: 'https://phys.org/rss-feed/earth-news/',
    category: 'science-news',
    descriptionKey: 'publisher.feeds.preset.physorg',
  },
  {
    id: 'sciencedaily-earth',
    kind: 'rss',
    label: 'ScienceDaily Earth & Climate', // i18n-exempt: proper name
    url: 'https://www.sciencedaily.com/rss/earth_climate.xml',
    category: 'science-news',
    descriptionKey: 'publisher.feeds.preset.sciencedaily',
  },
  // ── Reputable general news (environment/science sections) ────────
  {
    id: 'bbc-sci-env',
    kind: 'rss',
    label: 'BBC Science & Environment', // i18n-exempt: proper name
    url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
    category: 'news',
    descriptionKey: 'publisher.feeds.preset.bbc',
  },
  {
    id: 'guardian-env',
    kind: 'rss',
    label: 'The Guardian Environment', // i18n-exempt: proper name
    url: 'https://www.theguardian.com/environment/rss',
    category: 'news',
    descriptionKey: 'publisher.feeds.preset.guardian',
  },
  {
    id: 'nyt-climate',
    kind: 'rss',
    label: 'The New York Times Climate', // i18n-exempt: proper name
    url: 'https://rss.nytimes.com/services/xml/rss/nyt/Climate.xml',
    category: 'news',
    descriptionKey: 'publisher.feeds.preset.nyt',
  },
]
/* eslint-enable max-len */

/** Presets in a category, in catalog order. */
export function presetsForCategory(category: FeedPresetCategory): FeedPreset[] {
  return FEED_PRESETS.filter(p => p.category === category)
}
