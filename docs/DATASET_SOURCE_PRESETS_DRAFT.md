# Dataset Source Presets — Generated Draft (Phase A3 seed)

> **Status: generated draft — a snapshot, not a source of truth.**
> The A3 preset catalog is "generated, not typed"
> ([`WORKFLOW_AUTHORING_PLAN.md`](WORKFLOW_AUTHORING_PLAN.md)
> §Phase A3); this is the first generation. Every entry was induced
> from a real FTP directory listing captured by the tree-walk probe
> ([GHA run 29957132922](https://github.com/zyra-project/terraviz/actions/runs/29957132922),
> branch `claude/ftp-probe`, 2026-07-22, 152 directories). The
> freshness observations date that snapshot — expect drift, and
> re-run the sweep before turning this into
> `src/ui/publisher/dataset-source-presets.ts` when A3 lands. The
> plan's drift-checker open question owns keeping it honest after
> that.



## Sweep review — ready entries (in the draft catalog)

| Preset | Cadence | Server window | Freshness on 2026-07-22 |
|---|---|---|---|
| SST | daily | 1 yr (365) | to 07-12 (~10-day lag) |
| SST anomaly | daily | 1 yr | to 07-12 |
| Coral bleaching alert | daily | 31 d | to 07-21 |
| Coral DHW | weekly | 1 yr | to 07-19 |
| Coral HotSpots | daily | 31 d | to 07-12 |
| Chlorophyll | monthly | 12 mo | current |
| Geostationary composite (sat/linear) | 10 min | 30 d | to 07-22 20:20 (live) |
| GOES merged true color (5k) | 30 min | ~3 d | to 07-22 17:40 (live) |
| Clouds+precip combined | 30 min | 8 d | to 07-22 14:30 (live) |
| Precipitation (IMERG) | 30 min | 8 d | to 07-22 14:30 (live) |
| Ozone | daily | 1 yr | to 07-11 |
| Tropical cyclone tracks | 10 min | 30 d | to 07-21 (live) |
| Monthly temp anomaly | monthly | 12 mo | current |
| Drought | weekly | 1 yr | to 07-09 |
| Vegetation NDVI | weekly | 1 yr | to 07-05 |
| Fire | daily | 1 yr | to 07-10 |
| Snow & ice | daily | 1 yr | to 07-12 |
| True color | daily | 1 yr | to 07-20 |
| MODIS Aqua | daily | 7 d | to day 201 (07-20) |

Cross-cutting caveats already noted per entry: the science-quality
dailies (SST family, ozone, fire, snow/ice) lag ~10 days and land in
batches — the soft-pass staleness guard will treat them as
always-stale, so transient FTP failures surface as failed runs. The
live sub-hourly feeds are large (thousands of frames); the 10-min
composite is ~4,320 files per 30-day window.

## Flagged — usable with work, not in the draft

| Family | Why |
|---|---|
| `rt/land_temp` | Shape is fine (`land_temp_YYYYMMDD.png`, daily) but the feed is **stale since 2025-04-07** — over a year. Add only if upstream revives. |
| `rt/ssha` (sea surface height anomaly) | 10-day cadence, but last frame 2026-05-13 (~2 months stale). Worth an upstream ping. |
| `rt/quake/hires/2k` | Hourly, 30-day window, but filenames are `YYYYDDDHH` (e.g. `202617321`) — needs `%Y%j%H` support verified; also a `csv` feed exists that may suit a future vector path better. |
| `rt/sun_suvi/{171,304}` | GOES SUVI solar imagery, 4-min cadence — **solar disk, not an equirectangular Earth texture**; wrong render path for the globe. |

## Excluded — wrong shape for frame-sequence workflows

| Family | Why |
|---|---|
| `rt/view_models/GFS*` (6 products) + `rt/grids/**` | **Forecast runs**, not observation archives: each model cycle replaces the whole directory and frames are indexed by forecast hour (`GFSC_20260722_06z_237hr.color.080.png`, `2026-07-27-11z.jpg` — future dates). Needs replace-sync + hour-ordered scan semantics, not date-append. A real gap-issue candidate for upstream Zyra if forecast animations are wanted. |
| `rt/coral_bleaching/outlook` | Multi-variant per issuance (5 probability percentiles × overlapping validity windows) — not a single time series. |
| `rt/outlook/{precipitation,temperature}` | One seasonal poster image at a time, not a sequence. |
| `rt/earthnow` | Already a finished video product (`2048.mp4` + playlists). |

## Sweep quality notes

- `!! ... EMPTY-OR-FAILED` lines for `*/fits`, `*/processed_images`,
  `*/4096` under view_models, and `sat/linear/netcdf` are empty
  directories, not probe errors.
- The `Broken pipe` warnings in the log are `head` closing the pipe
  early on large listings — harmless.
- Resolution variants sometimes change the filename (e.g.
  `ozone_2048_*`, `sst_2048_*`, `green/4096_rename` with ISO dates) —
  the preset picker must treat resolution as part of the entry, not a
  suffix swap.

## The draft catalog

Copy-out seed for `src/ui/publisher/dataset-source-presets.ts`
(checked in here as documentation deliberately — nothing imports it,
so it stays out of the module maps and bundles until A3 wires it).

```ts
/**
 * DRAFT — A3 dataset-source preset catalog
 * (docs/WORKFLOW_AUTHORING_PLAN.md §Phase A3).
 *
 * Every entry induced from a real FTP directory listing captured by
 * the tree-walk probe (GHA run 29957132922 on claude/ftp-probe,
 * 2026-07-22, 152 dirs listed). Nothing here is guessed; the
 * companion review table (dataset-source-presets-review.md) records
 * per-product freshness observations and the families that were
 * deliberately excluded (forecast-run products, single-frame
 * posters, non-equirectangular solar imagery).
 *
 * Shape matches the plan sketch; wire to real portal types when A3
 * lands. periodSeconds is the scan-frames cadence; schedule is the
 * workflow-form preset (ISO-8601, ≥ PT15M per the tick floor).
 * fillMode 'nearest' throughout — all entries are continuous-field
 * or imagery products where repeating the neighbouring frame beats
 * compositing a basemap.
 */

export interface DatasetSourcePresetDraft {
  id: string
  /** Proper product name — i18n-exempt. */
  label: string
  /** FTP dir (preferred resolution baked in). */
  path: string
  /** Alternate resolution dirs, same filename shape unless noted. */
  altResolutions?: string[]
  pattern: string
  /** strftime for acquire date-format / scan-frames datetime-format. */
  dateFormat: string
  periodSeconds: number
  /** since-period matched to the server's own rolling window. */
  sincePeriod: string
  schedule: string
  attribution: string
  /** Operator-facing caveat (becomes an i18n key in the real file). */
  notes?: string
}

export const DATASET_SOURCE_PRESETS_DRAFT: readonly DatasetSourcePresetDraft[] = [
  // ── Ocean ─────────────────────────────────────────────────────────
  {
    id: 'sst-realtime',
    label: 'Sea Surface Temperature — Real-time',
    path: 'ftp://public.sos.noaa.gov/rt/sst/nesdis/sst/4096',
    altResolutions: ['2048'], // files there are sst_2048_YYYYMMDD.png — pattern differs
    pattern: '^sst_[0-9]{8}\\.png$',
    dateFormat: '%Y%m%d',
    periodSeconds: 86_400,
    sincePeriod: 'P1Y',
    schedule: 'P1D',
    attribution: 'NOAA NESDIS Coral Reef Watch',
    notes: 'Lags ~10 days; lands in multi-day batches. ~21 MB/frame at 4096 (~7.7 GB set).',
  },
  {
    id: 'sst-anomaly-realtime',
    label: 'Sea Surface Temperature Anomaly — Real-time',
    path: 'ftp://public.sos.noaa.gov/rt/sst/nesdis/sst_anom/4096',
    altResolutions: ['2048'],
    pattern: '^sst_anom_[0-9]{8}\\.png$',
    dateFormat: '%Y%m%d',
    periodSeconds: 86_400,
    sincePeriod: 'P1Y',
    schedule: 'P1D',
    attribution: 'NOAA NESDIS Coral Reef Watch',
    notes: 'Same lag/batching as SST. ~5 MB/frame (~1.9 GB set).',
  },
  {
    id: 'coral-bleaching-alert',
    label: 'Coral Bleaching Alert Area (7-day max)',
    path: 'ftp://public.sos.noaa.gov/rt/coral_bleaching/alert/4096',
    altResolutions: ['7200'],
    pattern: '^ct5km_baa-max-7d_v3\\.1_[0-9]{8}\\.png$',
    dateFormat: '%Y%m%d',
    periodSeconds: 86_400,
    sincePeriod: 'P31D',
    schedule: 'P1D',
    attribution: 'NOAA Coral Reef Watch',
    notes: '31-day server window. Version token (v3.1) in filename — preset goes stale on product version bumps.',
  },
  {
    id: 'coral-degree-heating-weeks',
    label: 'Coral Degree Heating Weeks (7-day)',
    path: 'ftp://public.sos.noaa.gov/rt/coral_bleaching/dhw/4096',
    altResolutions: ['7200'], // 7200 window starts later; same names
    pattern: '^CDHW\\.7-day\\.[0-9]{8}\\.color\\.png$',
    dateFormat: '%Y%m%d',
    periodSeconds: 604_800,
    sincePeriod: 'P1Y',
    schedule: 'P1W',
    attribution: 'NOAA Coral Reef Watch',
  },
  {
    id: 'coral-hotspots',
    label: 'Coral Bleaching HotSpots — Daily',
    path: 'ftp://public.sos.noaa.gov/rt/coral_bleaching/hotspot/4096',
    pattern: '^HotSpots_Daily_[0-9]{8}\\.png$',
    dateFormat: '%Y%m%d',
    periodSeconds: 86_400,
    sincePeriod: 'P31D',
    schedule: 'P1D',
    attribution: 'NOAA Coral Reef Watch',
  },
  {
    id: 'chlorophyll-monthly',
    label: 'Ocean Chlorophyll (Algae) — Monthly',
    path: 'ftp://public.sos.noaa.gov/rt/chla/4096',
    altResolutions: ['9600'],
    pattern: '^ALGE\\.monthly\\.[0-9]{6}\\.color\\.png$',
    dateFormat: '%Y%m',
    periodSeconds: 2_592_000,
    sincePeriod: 'P1Y',
    schedule: 'P30D',
    attribution: 'NOAA CoastWatch',
    notes: 'Calendar-month cadence approximated as 30 days — verify pad-missing tolerates the ±1-day drift.',
  },

  // ── Atmosphere ────────────────────────────────────────────────────
  {
    id: 'geostationary-composite',
    label: 'Global Geostationary Satellite Composite (IR/visible blend)',
    path: 'ftp://public.sos.noaa.gov/rt/sat/linear/medium',
    altResolutions: ['raw', 'greyscale (PNG, greyscale_rgb_cyl_*)', 'enhanced (enhanced_rgb_cyl_*)'],
    pattern: '^linear_rgb_cyl_[0-9]{8}_[0-9]{4}\\.jpg$',
    dateFormat: '%Y%m%d_%H%M',
    periodSeconds: 600,
    sincePeriod: 'P30D',
    schedule: 'PT1H',
    attribution: 'SSEC / CIMSS, University of Wisconsin–Madison',
    notes: 'The Clouds — Real-time source family. 10-min frames, 30-day window, ~4,320 files — size the cache accordingly.',
  },
  {
    id: 'goes-merged-truecolor',
    label: 'GOES Merged True Color',
    path: 'ftp://public.sos.noaa.gov/rt/goes_merged/5k',
    altResolutions: ['2500 (JPG, longer window, irregular early cadence)'],
    pattern: '^MERGED_TrueColor_[0-9]{8}_[0-9]{4}z\\.png$',
    dateFormat: '%Y%m%d_%H%M',
    periodSeconds: 1_800,
    sincePeriod: 'P3D',
    schedule: 'PT1H',
    attribution: 'NOAA NESDIS',
    notes: "Trailing 'z' in the timestamp — keep it in the pattern, out of the date format; verify zyra's extractor handles it.",
  },
  {
    id: 'clouds-precip-combined',
    label: 'Clouds + Precipitation Combined Imagery',
    path: 'ftp://public.sos.noaa.gov/rt/clouds_precip/4096',
    pattern: '^combined_image_[0-9]{8}_[0-9]{4}\\.jpg$',
    dateFormat: '%Y%m%d_%H%M',
    periodSeconds: 1_800,
    sincePeriod: 'P8D',
    schedule: 'PT1H',
    attribution: 'NOAA',
    notes: '30-min frames, 8-day window.',
  },
  {
    id: 'precipitation-imerg',
    label: 'Global Precipitation (IMERG Real-time)',
    path: 'ftp://public.sos.noaa.gov/rt/precip/3600',
    pattern: '^imergert_composite\\.[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}_[0-9]{2}_[0-9]{2}Z\\.png$',
    dateFormat: '%Y-%m-%dT%H_%M_%SZ',
    periodSeconds: 1_800,
    sincePeriod: 'P8D',
    schedule: 'PT1H',
    attribution: 'NASA GPM / NOAA',
    notes: 'ISO-with-underscores timestamp — verify the strftime round-trip before enabling.',
  },
  {
    id: 'ozone-daily',
    label: 'Total Ozone — Daily',
    path: 'ftp://public.sos.noaa.gov/rt/ozone/4096',
    altResolutions: ['2048 (ozone_2048_*.png — pattern differs)'],
    pattern: '^ozone_[0-9]{8}\\.png$',
    dateFormat: '%Y%m%d',
    periodSeconds: 86_400,
    sincePeriod: 'P1Y',
    schedule: 'P1D',
    attribution: 'NOAA',
    notes: 'Lags ~10 days, like the other daily composites.',
  },
  {
    id: 'tropical-cyclone-tracks',
    label: 'Tropical Cyclone Tracks — Real-time',
    path: 'ftp://public.sos.noaa.gov/rt/tropical_cyclones/2048_tracks',
    altResolutions: ['2048_clouds (linear_rgb_cyl_* satellite underlay)'],
    pattern: '^rt_cyclone_[0-9]{8}_[0-9]{4}\\.png$',
    dateFormat: '%Y%m%d_%H%M',
    periodSeconds: 600,
    sincePeriod: 'P30D',
    schedule: 'PT1H',
    attribution: 'NOAA / SSEC',
    notes: '10-min frames, 30-day window; colorbar.png + labels.txt at the family root for the legend.',
  },
  {
    id: 'monthly-temp-anomaly',
    label: 'Air Temperature Anomaly — Monthly',
    path: 'ftp://public.sos.noaa.gov/rt/monthly_temp_anom/4096',
    pattern: '^ANOM\\.monthly\\.[0-9]{6}\\.color\\.png$',
    dateFormat: '%Y%m',
    periodSeconds: 2_592_000,
    sincePeriod: 'P1Y',
    schedule: 'P30D',
    attribution: 'NOAA',
    notes: 'Calendar-month caveat as chlorophyll.',
  },

  // ── Land ──────────────────────────────────────────────────────────
  {
    id: 'drought-weekly',
    label: 'Drought Risk — Weekly',
    path: 'ftp://public.sos.noaa.gov/rt/drought/4096',
    pattern: '^drought_[0-9]{8}\\.png$',
    dateFormat: '%Y%m%d',
    periodSeconds: 604_800,
    sincePeriod: 'P1Y',
    schedule: 'P1W',
    attribution: 'NOAA / NIDIS',
    notes: 'Crops_Overlay.png at the family root is a static overlay asset, not a frame.',
  },
  {
    id: 'vegetation-ndvi',
    label: 'Vegetation (NDVI) — Weekly',
    path: 'ftp://public.sos.noaa.gov/rt/green/4096',
    altResolutions: ['2048', '4096_rename (ISO dates: NDVI.weekly.YYYY-MM-DD.png)'],
    pattern: '^NDVI\\.weekly\\.[0-9]{8}\\.color\\.png$',
    dateFormat: '%Y%m%d',
    periodSeconds: 604_800,
    sincePeriod: 'P1Y',
    schedule: 'P1W',
    attribution: 'NOAA STAR',
  },
  {
    id: 'fire-daily',
    label: 'Fire Detections — Daily',
    path: 'ftp://public.sos.noaa.gov/rt/fire/4096',
    pattern: '^fire_[0-9]{8}\\.png$',
    dateFormat: '%Y%m%d',
    periodSeconds: 86_400,
    sincePeriod: 'P1Y',
    schedule: 'P1D',
    attribution: 'NOAA',
  },

  // ── Cryosphere / whole-Earth ──────────────────────────────────────
  {
    id: 'snow-ice-daily',
    label: 'Snow and Ice Cover — Daily',
    path: 'ftp://public.sos.noaa.gov/rt/snow_ice/4096',
    altResolutions: ['2048 (snow_ice_2048_*.png)'],
    pattern: '^snow_ice_[0-9]{8}\\.png$',
    dateFormat: '%Y%m%d',
    periodSeconds: 86_400,
    sincePeriod: 'P1Y',
    schedule: 'P1D',
    attribution: 'NOAA',
  },
  {
    id: 'true-color-daily',
    label: 'True Color Earth — Daily',
    path: 'ftp://public.sos.noaa.gov/rt/true_color/4096',
    altResolutions: ['2048'],
    pattern: '^TRUE\\.daily\\.[0-9]{8}\\.color\\.png$',
    dateFormat: '%Y%m%d',
    periodSeconds: 86_400,
    sincePeriod: 'P1Y',
    schedule: 'P1D',
    attribution: 'NOAA CoastWatch',
  },
  {
    id: 'modis-daily',
    label: 'MODIS Aqua True Color — Daily',
    path: 'ftp://public.sos.noaa.gov/rt/modis/3600',
    pattern: '^MYD_143D_RR\\.[0-9]{7}\\.jpg$',
    dateFormat: '%Y%j',
    periodSeconds: 86_400,
    sincePeriod: 'P7D',
    schedule: 'P1D',
    attribution: 'NASA / NOAA',
    notes: 'Day-of-year dates (%Y%j) — verify zyra DateManager support. 7-day window only.',
  },
]
```
