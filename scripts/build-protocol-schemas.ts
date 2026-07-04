/**
 * Protocol schema generator — pins the PUBLIC wire contract as
 * versioned JSON Schema.
 *
 * Non-TypeScript consumers (the WordPress plugin's PHP server-side
 * blocks, future federation peers, any third-party node) should be
 * able to generate their own request/response types from a stable,
 * published artifact instead of reading the TypeScript. This is
 * federation-scoping.md §7 Directive 2 ("pin the wire format
 * publicly") and Phase 0 of docs/WORDPRESS_INTEGRATION_PLAN.md.
 *
 * Pattern mirrors scripts/build-privacy-page.ts: generate committed
 * artifacts, and a `--check` mode that fails CI when the committed
 * schemas drift from the TypeScript types. The output lives under
 * `public/schema/v1/` so Cloudflare Pages serves it at the stable
 * URL `https://<node>/schema/v1/<file>` for free (same
 * committed-generated-artifact idiom as `public/privacy.html`).
 *
 * Scope — the shapes that EXIST today:
 *   - WireDataset       → dataset.schema.json  (GET /api/v1/datasets/:id,
 *                          and each entry in GET /api/v1/catalog)
 *   - CatalogResponseBody → catalog.schema.json (GET /api/v1/catalog envelope)
 *   - WellKnownDoc      → well-known.schema.json (/.well-known/terraviz.json)
 *
 * DEFERRED to Phase 4: the federation feed schema. Its serializer does
 * not exist yet (no functions/api/v1/federation/), so pinning it now
 * would invent a shape and bake in accidents — exactly what Directive 2
 * warns against. See docs/protocol/README.md.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createGenerator, type Config } from 'ts-json-schema-generator'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = resolve(ROOT, 'public/schema/v1')
const TSCONFIG = resolve(ROOT, 'functions/tsconfig.json')

// Base URL stamped into each schema's `$id`. A fork / staging / partner
// node serves these from its own `<origin>/schema/v1/`, so the `$id`
// base is configurable — set `SCHEMA_BASE_URL` and regenerate to emit
// `$id`s that match your deployment. Defaults to the canonical origin,
// which is what the committed schemas carry. (Same "lift hardcoded URLs
// to env vars" fork-friendliness as docs/SELF_HOSTING.md.)
const DEFAULT_SCHEMA_BASE = 'https://terraviz.zyra-project.org/schema/v1'
const SCHEMA_BASE = (process.env.SCHEMA_BASE_URL ?? DEFAULT_SCHEMA_BASE).replace(/\/+$/, '')

interface Target {
  /** Output filename under public/schema/v1/. */
  file: string
  /** Source file declaring the type (repo-relative). */
  path: string
  /** Exported interface name to pin. */
  type: string
  /** Human title stamped onto the schema. */
  title: string
}

const TARGETS: readonly Target[] = [
  {
    file: 'dataset.schema.json',
    path: 'functions/api/v1/_lib/dataset-serializer.ts',
    type: 'WireDataset',
    title: 'Terraviz wire Dataset',
  },
  {
    file: 'catalog.schema.json',
    path: 'functions/api/v1/catalog.ts',
    type: 'CatalogResponseBody',
    title: 'Terraviz catalog response',
  },
  {
    file: 'well-known.schema.json',
    path: 'functions/.well-known/terraviz.json.ts',
    type: 'WellKnownDoc',
    title: 'Terraviz node discovery document',
  },
]

/**
 * Generate the JSON Schema string for one target. Deterministic
 * (`sortProps`) so the `--check` diff is stable across runs.
 * `additionalProperties: true` keeps the contract forward-compatible —
 * the wire format evolves additively, so a consumer validating against
 * v1 must not reject a response that carries a newer, unknown field.
 */
export function generateSchema(target: Target): string {
  const config: Config = {
    path: resolve(ROOT, target.path),
    tsconfig: TSCONFIG,
    type: target.type,
    expose: 'none',
    topRef: false,
    jsDoc: 'none',
    sortProps: true,
    additionalProperties: true,
    skipTypeCheck: true,
  }
  const schema = createGenerator(config).createSchema(target.type)
  // Front-load the schema metadata (draft, $id, title) then the body.
  const { $schema, ...body } = schema as Record<string, unknown>
  // `expose: 'none'` inlines every type, so the `definitions` bag is
  // always empty — drop it rather than ship a noise `"definitions": {}`.
  if (
    body.definitions &&
    typeof body.definitions === 'object' &&
    Object.keys(body.definitions as object).length === 0
  ) {
    delete body.definitions
  }
  const out = {
    $schema: $schema ?? 'http://json-schema.org/draft-07/schema#',
    $id: `${SCHEMA_BASE}/${target.file}`,
    title: target.title,
    ...body,
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

function run(): void {
  const check = process.argv.includes('--check')
  if (!check) mkdirSync(OUT_DIR, { recursive: true })

  let drifted = false
  for (const target of TARGETS) {
    const generated = generateSchema(target)
    const outPath = resolve(OUT_DIR, target.file)

    if (check) {
      let current: string
      try {
        current = readFileSync(outPath, 'utf-8')
      } catch {
        console.error(
          `✗ ${target.file} does not exist. Run \`npm run gen:protocol-schemas\`.`,
        )
        drifted = true
        continue
      }
      if (current !== generated) {
        console.error(
          `✗ public/schema/v1/${target.file} is stale relative to ${target.path} (${target.type}).\n` +
            '  Run `npm run gen:protocol-schemas` and commit the regenerated file.',
        )
        drifted = true
      } else {
        // eslint-disable-next-line no-console
        console.log(`✓ public/schema/v1/${target.file} is up to date`)
      }
    } else {
      writeFileSync(outPath, generated, 'utf-8')
      // eslint-disable-next-line no-console
      console.log(`✓ Generated public/schema/v1/${target.file} (${generated.length} bytes)`)
    }
  }

  if (check && drifted) process.exit(1)
}

// Only run the CLI when invoked as a script, not when imported by a
// test — mirrors scripts/build-privacy-page.ts.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run()
}
