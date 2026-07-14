/**
 * /publish/datasets/:id/edit — edit an existing dataset draft.
 *
 * Thin wrapper around the shared dataset form. The page fetches
 * the existing row (with its keyword + tag decorations) via
 * `GET /api/v1/publish/datasets/{id}`, then hands the prefilled
 * state off to `renderDatasetForm({ mode: 'edit', initial, ... })`.
 * The form handles validation, PUT submission, and the navigate-
 * to-detail-on-save redirect.
 *
 * 404 / session / server errors render the same back-link +
 * error-card shell as the read-only detail page so the publisher
 * always has a way out. The page-level fetch is intentionally
 * separate from the form's own error surface — once the row is
 * loaded the form takes over and reports its own submission
 * errors inline.
 */

import { fetchFeatures, renderFeatureDisabledCard } from '../features'
import { t } from '../../../i18n'
import { clearWarmupFlag, handleSessionError, publisherGet } from '../api'
import {
  renderDatasetForm,
  type DatasetFormOptions,
} from '../components/dataset-form'
import { buildErrorCard, type ErrorCardDetails } from '../components/error-card'
import type { DatasetDetailResponse } from '../types'

export type DatasetEditPageOptions = Omit<
  DatasetFormOptions,
  'mode' | 'initial' | 'dataUrl' | 'thumbnailUrl' | 'legendUrl' | 'initialKeywords' | 'initialTags'
>

function endpoint(id: string): string {
  return `/api/v1/publish/datasets/${encodeURIComponent(id)}`
}

function backLink(): HTMLElement {
  const a = document.createElement('a')
  a.href = '/publish/datasets'
  a.className = 'publisher-back-link'
  a.textContent = `← ${t('publisher.datasetDetail.backToList')}`
  return a
}

function renderLoading(content: HTMLElement): void {
  const shell = document.createElement('main')
  shell.className = 'publisher-shell'
  shell.setAttribute('aria-busy', 'true')
  const status = document.createElement('p')
  status.className = 'publisher-loading'
  status.setAttribute('role', 'status')
  status.textContent = t('publisher.datasetEdit.loading')
  shell.appendChild(status)
  content.replaceChildren(shell)
}

function renderError(
  content: HTMLElement,
  kind: 'session' | 'server' | 'network' | 'not_found',
  details: ErrorCardDetails = {},
): void {
  const shell = document.createElement('main')
  shell.className = 'publisher-shell'
  shell.appendChild(backLink())
  shell.appendChild(buildErrorCard(kind, details))
  content.replaceChildren(shell)
}

export async function renderDatasetEditPage(
  content: HTMLElement,
  id: string,
  options: DatasetEditPageOptions = {},
): Promise<void> {
  if (!(await fetchFeatures()).datasets) {
    renderFeatureDisabledCard(content, 'datasets')
    return
  }
  renderLoading(content)
  const result = await publisherGet<DatasetDetailResponse>(endpoint(id), {
    fetchFn: options.fetchFn,
    sleep: options.sleep,
  })
  if (!result.ok) {
    if (result.kind === 'session') {
      if (handleSessionError({ navigate: options.navigate }) === 'show-error') {
        renderError(content, 'session')
      }
      return
    }
    if (result.kind === 'server') {
      renderError(content, 'server', { status: result.status, body: result.body })
      return
    }
    renderError(content, result.kind)
    return
  }
  clearWarmupFlag()
  // The whole catalog is visible, but editing stays owner-scoped. A
  // non-owner who deep-links to `/edit` (the Edit affordance is hidden
  // for them elsewhere) is bounced to the read-only detail page rather
  // than shown a form whose Save would 404. `can_edit` absent (older
  // payload / fixture) is treated as editable.
  if (result.data.dataset.can_edit === false) {
    const detailHref = `/publish/datasets/${encodeURIComponent(id)}`
    if (options.navigate) options.navigate(detailHref)
    else window.location.href = detailHref
    return
  }
  renderDatasetForm(content, {
    ...options,
    mode: 'edit',
    initial: result.data.dataset,
    dataUrl: result.data.data_url ?? null,
    thumbnailUrl: result.data.thumbnail_url ?? null,
    legendUrl: result.data.legend_url ?? null,
    initialKeywords: result.data.keywords ?? [],
    initialTags: result.data.tags ?? [],
  })
}
