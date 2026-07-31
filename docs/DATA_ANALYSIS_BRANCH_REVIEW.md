# Data-analysis branch review

Reviewed 2026-07-31 against the second parent of merge commit `1197050`
(the merged `main` lineage). The focused analysis test suite and the full
TypeScript/documentation gate pass; the findings below are documentation and
design-contract inconsistencies rather than test failures.

## Findings

### 1. High — the implementation plan still describes shipped work as unbuilt

`DATA_ANALYSIS_PLAN.md` says that no phases or code have landed, and its
"What exists today" table still says there is no texel-to-coordinate mapping,
colorbar, block readback, dataset-value charting, or numeric Orbit context.
The branch now implements A1, A2, A3, A4, and A6 in the modules named by that
same plan. This makes the plan actively misleading as an onboarding and review
document, rather than merely historical.

**Recommendation:** change the header to an implementation-status summary,
mark A1/A2/A3/A4/A6 as shipped on this branch, and rewrite "What exists today"
as a current capability matrix. Keep A0, A5, A7, and A8 explicitly unbuilt.

### 2. High — the settled nodata contract (A0) did not land before its consumers

The plan says the nodata decision is settled and that `dataMinLuma` lands as an
optional `ColorScale` field. No `dataMinLuma` field exists in the type,
validator, or generated schemas on this branch. The new statistics code instead
derives the first data-bearing code from the existing alpha/transparent range.
That may be an intentional interim design, but the plan currently presents the
new sidecar contract as decided while neither implementing it nor documenting
the substitution.

**Recommendation:** either implement A0 and regenerate both protocol schemas,
or revise the settled decision and A2 description to record the alpha-derived
behavior and its limits. Do not leave the public contract implied by the plan
but absent from the schema.

### 3. Medium — A6 promises four tools and a register entry, but ships three and no entry

The A6 phase promises "four round-trip tools" and names an update to
`LLM_INTEGRATION_OPPORTUNITIES.md`. The implementation offers three tools:
`probe_value`, `summarize_region`, and `find_extremum`; the value register has no
corresponding entry. The three-tool design is internally consistent in the
prompt and executors, so this appears to be stale planning text, not a missing
runtime branch.

**Recommendation:** name the intended fourth tool and implement it, or change
the plan to three. For the register, either add the historical/promoted entry or
state that the dedicated plan supersedes the idea-register step.

### 4. Medium — the new overlays bypass the documented design tokens

The style guide names `--color-surface-border-subtle` and `--glass-bg` as the
glass-surface tokens. The new Analyze and colorbar styles instead request
`--color-border` and `--color-surface-glass`, neither of which is defined by the
token sources, and therefore always use local fallback values. Those fallbacks
also differ from the guide's glass border and background. The result looks
plausible but cannot follow future theme/token changes, contradicting the
guide's "source of truth" contract.

**Recommendation:** use the existing generated tokens (normally
`--color-surface-border-subtle` and `--glass-bg`/`--glass-bg-light`) and add
Analyze/colorbar component tokens only where a genuinely new semantic value is
needed.

### 5. Medium — user and contributor documentation omits the branch's primary features

The README feature list, usage steps, project tree, Orbit capability list, and
key-files list do not mention data-encoded color controls, regional statistics,
CSV export, transects, or Orbit's numeric tools. Conversely, the plan is the
only narrative documentation for those features, and it calls them unbuilt.
A user cannot discover the functionality from the main documentation, while a
contributor cannot locate its modules from the documented project structure.

**Recommendation:** after resolving findings 1–3, add concise README entries
for the data-encoded colorbar/Analyze workflow and numeric Orbit answers, and
add the new service/UI modules to the project structure or key-files section.

## Checks performed

- `npm run type-check`
- `npm test -- --run src/services/colorScaleDisplay.test.ts src/services/datasetStats.test.ts src/services/docentAnalysisTools.test.ts src/services/docentContext.test.ts src/services/docentService.test.ts src/services/mapRendererProbeSource.test.ts src/ui/analyzeUI.test.ts src/ui/analyzeCharts.test.ts src/ui/chatUI.test.ts src/ui/colorbarUI.test.ts`
- `rg` audits across the branch diff, plan, README, style guide, LLM value
  register, generated schemas, source module map, and new overlay styles.

