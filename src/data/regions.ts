/**
 * Common region bounding boxes for name-based region resolution.
 *
 * Each entry maps a lowercase name to [west, south, east, north] bounds.
 * Used by the LLM's <<REGION:name>> marker and highlight_region tool
 * to resolve place names to geometry without the LLM generating GeoJSON.
 *
 * Bounding boxes are approximate — good enough for fitBounds + highlighting.
 * Full polygon data would add significant bundle size for minimal visual gain
 * at the globe scale this app operates at.
 */

export interface RegionEntry {
  /** Display name */
  name: string
  /** [west, south, east, north] in degrees */
  bounds: [number, number, number, number]
}

/**
 * Resolve a region name to its bounding box.
 * Case-insensitive, supports common aliases.
 * Returns null if not found.
 */
export function resolveRegion(name: string): RegionEntry | null {
  const key = name.trim().toLowerCase()
  return REGION_LOOKUP.get(key) ?? null
}

/** Get all known region names (for LLM context). */
export function getRegionNames(): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const entry of REGION_LOOKUP.values()) {
    if (!seen.has(entry.name)) {
      seen.add(entry.name)
      names.push(entry.name)
    }
  }
  return names.sort()
}

/**
 * Convert a bounding box to a simple GeoJSON Polygon feature.
 */
export function boundsToGeoJSON(bounds: [number, number, number, number], name?: string): GeoJSON.Feature {
  const [west, south, east, north] = bounds
  return {
    type: 'Feature',
    properties: { name: name ?? '' },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ]],
    },
  }
}

// --- Region data ---

const entries: Array<[string[], RegionEntry]> = [
  // Continents
  [['africa'], { name: 'Africa', bounds: [-17.5, -35, 51.5, 37.5] }],
  [['north america', 'na'], { name: 'North America', bounds: [-168, 7, -52, 84] }],
  [['south america', 'sa'], { name: 'South America', bounds: [-82, -56, -34, 13] }],
  [['europe'], { name: 'Europe', bounds: [-25, 35, 45, 72] }],
  [['asia'], { name: 'Asia', bounds: [25, -12, 180, 77] }],
  [['oceania', 'australia and oceania'], { name: 'Oceania', bounds: [110, -50, 180, 0] }],
  [['antarctica'], { name: 'Antarctica', bounds: [-180, -90, 180, -60] }],
  [['arctic', 'arctic ocean'], { name: 'Arctic', bounds: [-180, 60, 180, 90] }],

  // Oceans
  [['pacific ocean', 'pacific'], { name: 'Pacific Ocean', bounds: [120, -60, -70, 60] }],
  [['atlantic ocean', 'atlantic'], { name: 'Atlantic Ocean', bounds: [-80, -60, 0, 65] }],
  [['indian ocean'], { name: 'Indian Ocean', bounds: [20, -60, 120, 30] }],
  [['southern ocean'], { name: 'Southern Ocean', bounds: [-180, -70, 180, -45] }],

  // Major seas / basins
  [['mediterranean', 'mediterranean sea'], { name: 'Mediterranean Sea', bounds: [-6, 30, 36.5, 46] }],
  [['caribbean', 'caribbean sea'], { name: 'Caribbean Sea', bounds: [-88, 8, -59, 24] }],
  [['gulf of mexico'], { name: 'Gulf of Mexico', bounds: [-98, 18, -80, 31] }],
  [['south china sea'], { name: 'South China Sea', bounds: [100, 0, 122, 24] }],
  [['bay of bengal'], { name: 'Bay of Bengal', bounds: [78, 5, 97, 23] }],
  [['bering sea'], { name: 'Bering Sea', bounds: [162, 51, -157, 66] }],
  [['coral sea'], { name: 'Coral Sea', bounds: [143, -26, 170, -10] }],
  [['red sea'], { name: 'Red Sea', bounds: [32, 12.5, 44, 30] }],

  // Countries (major — ~50 most commonly discussed in Earth science context)
  [['united states', 'usa', 'us', 'united states of america'], { name: 'United States', bounds: [-125, 24.5, -66.5, 49.5] }],
  [['alaska'], { name: 'Alaska', bounds: [-180, 51, -130, 72] }],
  [['hawaii'], { name: 'Hawaii', bounds: [-161, 18.5, -154.5, 22.5] }],
  [['canada'], { name: 'Canada', bounds: [-141, 41.7, -52, 83.5] }],
  [['mexico'], { name: 'Mexico', bounds: [-118, 14.5, -86.5, 33] }],
  [['brazil'], { name: 'Brazil', bounds: [-74, -33.5, -34.5, 5.5] }],
  [['argentina'], { name: 'Argentina', bounds: [-73.5, -55, -53.5, -21.5] }],
  [['colombia'], { name: 'Colombia', bounds: [-79.5, -4.5, -66.5, 13.5] }],
  [['peru'], { name: 'Peru', bounds: [-81.5, -18.5, -68.5, -0.5] }],
  [['chile'], { name: 'Chile', bounds: [-76, -56, -66.5, -17.5] }],
  [['united kingdom', 'uk', 'great britain', 'britain'], { name: 'United Kingdom', bounds: [-8, 49.5, 2, 61] }],
  [['france'], { name: 'France', bounds: [-5, 42.3, 8.3, 51.1] }],
  [['germany'], { name: 'Germany', bounds: [5.9, 47.3, 15.1, 55] }],
  [['spain'], { name: 'Spain', bounds: [-9.5, 36, 3.3, 43.8] }],
  [['italy'], { name: 'Italy', bounds: [6.6, 36.6, 18.5, 47.1] }],
  [['norway'], { name: 'Norway', bounds: [4.5, 58, 31.5, 71.2] }],
  [['sweden'], { name: 'Sweden', bounds: [11, 55.3, 24.2, 69.1] }],
  [['iceland'], { name: 'Iceland', bounds: [-24.5, 63.3, -13.5, 66.5] }],
  [['greenland'], { name: 'Greenland', bounds: [-73.5, 60, -12, 84] }],
  [['russia', 'russian federation'], { name: 'Russia', bounds: [27, 41, 180, 82] }],
  [['china', 'prc'], { name: 'China', bounds: [73.5, 18, 135, 53.5] }],
  [['india'], { name: 'India', bounds: [68, 6.5, 97.5, 35.5] }],
  [['japan'], { name: 'Japan', bounds: [127, 24, 146, 46] }],
  [['indonesia'], { name: 'Indonesia', bounds: [95, -11, 141, 6] }],
  [['philippines'], { name: 'Philippines', bounds: [117, 5, 127, 21] }],
  [['australia'], { name: 'Australia', bounds: [113, -44, 154, -10] }],
  [['new zealand'], { name: 'New Zealand', bounds: [166, -47.5, 178.5, -34] }],
  [['south africa'], { name: 'South Africa', bounds: [16.5, -35, 33, -22] }],
  [['egypt'], { name: 'Egypt', bounds: [24.5, 22, 37, 31.8] }],
  [['nigeria'], { name: 'Nigeria', bounds: [2.7, 4.3, 14.7, 14] }],
  [['kenya'], { name: 'Kenya', bounds: [33.9, -4.7, 41.9, 5.5] }],
  [['ethiopia'], { name: 'Ethiopia', bounds: [33, 3.4, 48, 15] }],
  [['madagascar'], { name: 'Madagascar', bounds: [43, -25.6, 50.5, -12] }],
  [['iran'], { name: 'Iran', bounds: [44, 25, 63.5, 40] }],
  [['saudi arabia'], { name: 'Saudi Arabia', bounds: [34.5, 16.3, 55.7, 32.2] }],
  [['turkey', 'turkiye'], { name: 'Turkey', bounds: [26, 36, 45, 42.2] }],
  [['pakistan'], { name: 'Pakistan', bounds: [60.9, 23.7, 77, 37.1] }],
  [['bangladesh'], { name: 'Bangladesh', bounds: [88, 20.6, 92.7, 26.6] }],
  [['thailand'], { name: 'Thailand', bounds: [97.3, 5.6, 105.6, 20.5] }],
  [['vietnam'], { name: 'Vietnam', bounds: [102.1, 8.4, 109.5, 23.4] }],
  [['south korea', 'korea'], { name: 'South Korea', bounds: [126, 33, 130, 38.6] }],

  // US states
  [['alabama'], { name: 'Alabama', bounds: [-88.5, 30.2, -84.9, 35] }],
  [['arizona'], { name: 'Arizona', bounds: [-114.8, 31.3, -109, 37] }],
  [['arkansas'], { name: 'Arkansas', bounds: [-94.6, 33, -89.6, 36.5] }],
  [['california'], { name: 'California', bounds: [-124.5, 32.5, -114.1, 42] }],
  [['colorado'], { name: 'Colorado', bounds: [-109.1, 37, -102, 41] }],
  [['connecticut'], { name: 'Connecticut', bounds: [-73.7, 41, -71.8, 42.1] }],
  [['delaware'], { name: 'Delaware', bounds: [-75.8, 38.5, -75, 39.8] }],
  [['florida'], { name: 'Florida', bounds: [-87.6, 24.5, -80, 31] }],
  [['georgia'], { name: 'Georgia', bounds: [-85.6, 30.4, -80.8, 35] }],
  [['idaho'], { name: 'Idaho', bounds: [-117.2, 42, -111, 49] }],
  [['illinois'], { name: 'Illinois', bounds: [-91.5, 37, -87.5, 42.5] }],
  [['indiana'], { name: 'Indiana', bounds: [-88.1, 37.8, -84.8, 41.8] }],
  [['iowa'], { name: 'Iowa', bounds: [-96.6, 40.4, -90.1, 43.5] }],
  [['kansas'], { name: 'Kansas', bounds: [-102.1, 37, -94.6, 40] }],
  [['kentucky'], { name: 'Kentucky', bounds: [-89.6, 36.5, -82, 39.1] }],
  [['louisiana'], { name: 'Louisiana', bounds: [-94.1, 28.9, -89, 33] }],
  [['maine'], { name: 'Maine', bounds: [-71.1, 43, -67, 47.5] }],
  [['maryland'], { name: 'Maryland', bounds: [-79.5, 38, -75, 39.7] }],
  [['massachusetts'], { name: 'Massachusetts', bounds: [-73.5, 41.2, -69.9, 42.9] }],
  [['michigan'], { name: 'Michigan', bounds: [-90.4, 41.7, -82.4, 48.3] }],
  [['minnesota'], { name: 'Minnesota', bounds: [-97.2, 43.5, -89.5, 49.4] }],
  [['mississippi'], { name: 'Mississippi', bounds: [-91.7, 30.2, -88.1, 35] }],
  [['missouri'], { name: 'Missouri', bounds: [-95.8, 36, -89.1, 40.6] }],
  [['montana'], { name: 'Montana', bounds: [-116.1, 44.4, -104, 49] }],
  [['nebraska'], { name: 'Nebraska', bounds: [-104.1, 40, -95.3, 43] }],
  [['nevada'], { name: 'Nevada', bounds: [-120, 35, -114, 42] }],
  [['new hampshire'], { name: 'New Hampshire', bounds: [-72.6, 42.7, -70.7, 45.3] }],
  [['new jersey'], { name: 'New Jersey', bounds: [-75.6, 38.9, -73.9, 41.4] }],
  [['new mexico'], { name: 'New Mexico', bounds: [-109.1, 31.3, -103, 37] }],
  [['new york'], { name: 'New York', bounds: [-79.8, 40.5, -71.9, 45] }],
  [['north carolina'], { name: 'North Carolina', bounds: [-84.3, 33.8, -75.5, 36.6] }],
  [['north dakota'], { name: 'North Dakota', bounds: [-104.1, 45.9, -96.6, 49] }],
  [['ohio'], { name: 'Ohio', bounds: [-84.8, 38.4, -80.5, 42] }],
  [['oklahoma'], { name: 'Oklahoma', bounds: [-103, 33.6, -94.4, 37] }],
  [['oregon'], { name: 'Oregon', bounds: [-124.6, 42, -116.5, 46.3] }],
  [['pennsylvania'], { name: 'Pennsylvania', bounds: [-80.5, 39.7, -74.7, 42.3] }],
  [['rhode island'], { name: 'Rhode Island', bounds: [-71.9, 41.1, -71.1, 42.1] }],
  [['south carolina'], { name: 'South Carolina', bounds: [-83.4, 32, -78.5, 35.2] }],
  [['south dakota'], { name: 'South Dakota', bounds: [-104.1, 42.5, -96.4, 46] }],
  [['tennessee'], { name: 'Tennessee', bounds: [-90.3, 35, -81.6, 36.7] }],
  [['texas'], { name: 'Texas', bounds: [-106.6, 25.8, -93.5, 36.5] }],
  [['utah'], { name: 'Utah', bounds: [-114.1, 37, -109, 42] }],
  [['vermont'], { name: 'Vermont', bounds: [-73.4, 42.7, -71.5, 45.1] }],
  [['virginia'], { name: 'Virginia', bounds: [-83.7, 36.5, -75.2, 39.5] }],
  [['washington'], { name: 'Washington', bounds: [-124.8, 45.5, -116.9, 49] }],
  [['west virginia'], { name: 'West Virginia', bounds: [-82.6, 37.2, -77.7, 40.6] }],
  [['wisconsin'], { name: 'Wisconsin', bounds: [-92.9, 42.5, -86.8, 47.1] }],
  [['wyoming'], { name: 'Wyoming', bounds: [-111.1, 41, -104, 45] }],

  // Major geographic regions (commonly discussed in Earth science)
  [['amazon', 'amazon basin', 'amazon rainforest'], { name: 'Amazon Basin', bounds: [-79, -20, -44, 5] }],
  [['sahara', 'sahara desert'], { name: 'Sahara Desert', bounds: [-16, 15, 35, 37] }],
  [['sahel'], { name: 'Sahel', bounds: [-17, 10, 40, 20] }],
  [['great barrier reef'], { name: 'Great Barrier Reef', bounds: [142.5, -24.5, 154, -10.5] }],
  [['himalayas', 'himalaya'], { name: 'Himalayas', bounds: [72, 26.5, 96, 36] }],
  [['andes'], { name: 'Andes', bounds: [-80, -56, -62, 11] }],
  [['rocky mountains', 'rockies'], { name: 'Rocky Mountains', bounds: [-120, 31, -104, 60] }],
  [['great plains'], { name: 'Great Plains', bounds: [-106, 30, -95, 50] }],
  [['siberia'], { name: 'Siberia', bounds: [60, 50, 180, 77] }],
  [['middle east'], { name: 'Middle East', bounds: [25, 12, 63, 42] }],
  [['southeast asia'], { name: 'Southeast Asia', bounds: [92, -11, 141, 28] }],
  [['central america'], { name: 'Central America', bounds: [-92, 7, -77, 18.5] }],
  [['east africa', 'horn of africa'], { name: 'East Africa', bounds: [28, -12, 52, 18] }],
  [['west africa'], { name: 'West Africa', bounds: [-18, 4, 16, 25] }],
  [['southern africa'], { name: 'Southern Africa', bounds: [11, -35, 41, -10] }],
  [['northern europe', 'scandinavia'], { name: 'Northern Europe', bounds: [4, 54, 32, 72] }],
  [['tornado alley'], { name: 'Tornado Alley', bounds: [-104, 30, -90, 44] }],
  [['ring of fire', 'pacific ring of fire'], { name: 'Ring of Fire', bounds: [120, -50, -65, 60] }],
  [['gulf stream'], { name: 'Gulf Stream', bounds: [-82, 24, -10, 55] }],
  [['el nino region', 'nino 3.4', 'enso'], { name: 'ENSO Region (Niño 3.4)', bounds: [-170, -5, -120, 5] }],
  [['coral triangle'], { name: 'Coral Triangle', bounds: [95, -12, 163, 20] }],
  [['great lakes'], { name: 'Great Lakes', bounds: [-92.5, 41, -76, 49] }],
  [['congo basin', 'congo rainforest'], { name: 'Congo Basin', bounds: [15, -7, 32, 5] }],
  [['tibetan plateau', 'tibet'], { name: 'Tibetan Plateau', bounds: [77, 27, 104, 40] }],
]

// Build lookup map with all aliases pointing to the same entry
const REGION_LOOKUP = new Map<string, RegionEntry>()
for (const [aliases, entry] of entries) {
  for (const alias of aliases) {
    REGION_LOOKUP.set(alias, entry)
  }
}
