// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

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
  {
    id: 'nhc-atlantic',
    kind: 'rss',
    label: 'NOAA NHC Atlantic tropical cyclones', // i18n-exempt: proper name
    url: 'https://www.nhc.noaa.gov/index-at.xml',
    category: 'hazards',
    descriptionKey: 'publisher.feeds.preset.nhcAtlantic',
  },
  {
    id: 'nhc-epacific',
    kind: 'rss',
    label: 'NOAA NHC East Pacific tropical cyclones', // i18n-exempt: proper name
    url: 'https://www.nhc.noaa.gov/index-ep.xml',
    category: 'hazards',
    descriptionKey: 'publisher.feeds.preset.nhcEpacific',
  },
  {
    id: 'nws-severe',
    kind: 'rss',
    label: 'NWS severe & extreme weather alerts', // i18n-exempt: proper name
    url: 'https://api.weather.gov/alerts/active.atom?severity=Extreme,Severe',
    category: 'hazards',
    descriptionKey: 'publisher.feeds.preset.nwsSevere',
  },
  {
    id: 'ptwc-tsunami',
    kind: 'rss',
    label: 'NOAA PTWC Pacific tsunami messages', // i18n-exempt: proper name
    url: 'https://www.tsunami.gov/events/xml/PHEBAtom.xml',
    category: 'hazards',
    descriptionKey: 'publisher.feeds.preset.ptwc',
  },
  {
    id: 'reliefweb-disasters',
    kind: 'rss',
    label: 'ReliefWeb disasters (UN OCHA)', // i18n-exempt: proper name
    url: 'https://reliefweb.int/disasters/rss.xml',
    category: 'hazards',
    descriptionKey: 'publisher.feeds.preset.reliefweb',
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
    id: 'noaa-news',
    kind: 'rss',
    label: 'NOAA newsroom', // i18n-exempt: proper name
    url: 'https://www.noaa.gov/rss.xml',
    category: 'science-news',
    descriptionKey: 'publisher.feeds.preset.noaaNews',
  },
  {
    id: 'copernicus-news',
    kind: 'rss',
    label: 'Copernicus programme news', // i18n-exempt: proper name
    url: 'https://www.copernicus.eu/en/rss.xml',
    category: 'science-news',
    descriptionKey: 'publisher.feeds.preset.copernicus',
  },
  {
    id: 'cams-news',
    kind: 'rss',
    label: 'Copernicus Atmosphere (CAMS)', // i18n-exempt: proper name
    url: 'https://atmosphere.copernicus.eu/rss.xml',
    category: 'science-news',
    descriptionKey: 'publisher.feeds.preset.cams',
  },
  {
    id: 'eumetsat-news',
    kind: 'rss',
    label: 'EUMETSAT news', // i18n-exempt: proper name
    url: 'https://www.eumetsat.int/rss.xml',
    category: 'science-news',
    descriptionKey: 'publisher.feeds.preset.eumetsat',
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
