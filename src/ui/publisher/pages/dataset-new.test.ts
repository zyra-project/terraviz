import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderDatasetNewPage, dateTimeToIso } from './dataset-new'
import { suggestedLicense } from '../components/dataset-form'

function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function setInput(mount: HTMLElement, selector: string, value: string): void {
  const el = mount.querySelector<HTMLInputElement>(selector)!
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function setInputOnly(mount: HTMLElement, selector: string, value: string): void {
  const el = mount.querySelector<HTMLInputElement>(selector)!
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function clickRadio(mount: HTMLElement, name: string, value: string): void {
  const id = `${name}-${value.replace(/\W/g, '-')}`
  const el = mount.querySelector<HTMLInputElement>(`#${id}`)!
  el.checked = true
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function submitForm(mount: HTMLElement): void {
  const form = mount.querySelector<HTMLFormElement>('form.publisher-form')!
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

describe('dateTimeToIso', () => {
  it('returns empty string when date is empty', () => {
    expect(dateTimeToIso('', '')).toBe('')
    expect(dateTimeToIso('', '12:30')).toBe('')
  })

  it('returns empty string for unparseable date', () => {
    expect(dateTimeToIso('not a date', '12:30')).toBe('')
  })

  it('defaults time to 00:00 when only date is supplied', () => {
    const iso = dateTimeToIso('2026-04-01', '')
    // Test runner's TZ varies; assert on shape (date + Z suffix)
    // rather than a literal offset.
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
  })

  it('composes date + time into a valid ISO 8601 UTC string', () => {
    const iso = dateTimeToIso('2026-04-01', '14:30')
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
  })
})

describe('renderDatasetNewPage', () => {
  let mount: HTMLDivElement

  beforeEach(() => {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    sessionStorage.clear()
  })

  it('renders the new-dataset heading and the required form fields', () => {
    renderDatasetNewPage(mount)
    expect(mount.querySelector('.publisher-detail-title')?.textContent).toBe(
      'New dataset',
    )
    expect(mount.querySelector('#dataset-title')).not.toBeNull()
    expect(mount.querySelector('#dataset-slug')).not.toBeNull()
    expect(mount.querySelectorAll('input[name="format"]').length).toBe(5)
    expect(mount.querySelectorAll('input[name="visibility"]').length).toBe(4)
  })

  it('is a stepper: shows only the active section, switchable via the rail', () => {
    renderDatasetNewPage(mount)
    // Identity is the default active section.
    expect(mount.querySelector<HTMLElement>('#ds-section-identity')?.style.display).not.toBe('none')
    expect(mount.querySelector<HTMLElement>('#ds-section-licensing')?.style.display).toBe('none')
    expect(mount.querySelector('.publisher-form-nav-link-active')?.textContent).toBe('Identity')
    // Publish-readiness checklist renders with the deck's 5 items.
    expect(mount.querySelector('.publisher-form-readiness-count')?.textContent).toBe('1 of 5 ready')
    expect(mount.querySelectorAll('.publisher-form-readiness-item').length).toBe(5)

    // Clicking a rail item switches the visible section.
    const licensingTab = Array.from(
      mount.querySelectorAll<HTMLButtonElement>('.publisher-form-nav-link'),
    ).find(b => b.textContent === 'Licensing & attribution')!
    licensingTab.click()
    expect(mount.querySelector<HTMLElement>('#ds-section-licensing')?.style.display).not.toBe('none')
    expect(mount.querySelector<HTMLElement>('#ds-section-identity')?.style.display).toBe('none')
    expect(mount.querySelector('.publisher-form-nav-link-active')?.textContent).toBe('Licensing & attribution')
  })

  it('suggestedLicense maps the two chooser answers to a CC license', () => {
    expect(suggestedLicense('yes', 'yes')?.spdx).toBe('CC-BY-4.0')
    expect(suggestedLicense('yes', 'no')?.spdx).toBe('CC-BY-NC-4.0')
    expect(suggestedLicense('sharealike', 'yes')?.spdx).toBe('CC-BY-SA-4.0')
    expect(suggestedLicense('no', 'no')?.spdx).toBe('CC-BY-NC-ND-4.0')
    expect(suggestedLicense('yes', '')).toBeNull()
    expect(suggestedLicense('', '')).toBeNull()
  })

  it('the license chooser fills the SPDX + URL fields', () => {
    renderDatasetNewPage(mount)
    // Open the Licensing section (stepper).
    const tab = Array.from(mount.querySelectorAll<HTMLButtonElement>('.publisher-form-nav-link')).find(
      b => b.dataset.section === 'ds-section-licensing',
    )!
    tab.click()
    expect(mount.querySelector('.publisher-license-chooser')).not.toBeNull()

    // A quick-pick chip fills SPDX directly.
    const cc0 = Array.from(mount.querySelectorAll<HTMLButtonElement>('.publisher-license-chooser-chip')).find(
      b => b.textContent === 'CC0-1.0',
    )!
    cc0.click()
    expect(mount.querySelector<HTMLInputElement>('#dataset-license-spdx')?.value).toBe('CC0-1.0')

    // Answering both questions and clicking Apply fills the suggestion.
    mount.querySelector<HTMLInputElement>('input[name="dataset-license-adapt"][value="yes"]')!.click()
    mount.querySelector<HTMLInputElement>('input[name="dataset-license-commercial"][value="yes"]')!.click()
    mount.querySelector<HTMLButtonElement>('.publisher-license-chooser-apply')!.click()
    expect(mount.querySelector<HTMLInputElement>('#dataset-license-spdx')?.value).toBe('CC-BY-4.0')
    expect(mount.querySelector<HTMLInputElement>('#dataset-license-url')?.value).toContain(
      'creativecommons.org/licenses/by/4.0',
    )
  })

  it('defaults to format=video/mp4 and visibility=public', () => {
    renderDatasetNewPage(mount)
    const checkedFormat = mount.querySelector<HTMLInputElement>(
      'input[name="format"]:checked',
    )
    const checkedVis = mount.querySelector<HTMLInputElement>(
      'input[name="visibility"]:checked',
    )
    expect(checkedFormat?.value).toBe('video/mp4')
    expect(checkedVis?.value).toBe('public')
  })

  it('auto-derives the slug from the title as the user types', () => {
    renderDatasetNewPage(mount)
    setInputOnly(mount, '#dataset-title', 'Sea Surface Temperature — April 2026')
    const slug = mount.querySelector<HTMLInputElement>('#dataset-slug')!
    expect(slug.value).toBe('sea-surface-temperature-april-2026')
  })

  it('stops auto-deriving once the user edits the slug manually', () => {
    renderDatasetNewPage(mount)
    setInputOnly(mount, '#dataset-title', 'First title')
    setInputOnly(mount, '#dataset-slug', 'my-custom-slug')
    setInputOnly(mount, '#dataset-title', 'Second title')
    const slug = mount.querySelector<HTMLInputElement>('#dataset-slug')!
    expect(slug.value).toBe('my-custom-slug')
  })

  it('prefixes a slug derived from non-letter title with `dataset-`', () => {
    renderDatasetNewPage(mount)
    setInputOnly(mount, '#dataset-title', '2026 summary')
    const slug = mount.querySelector<HTMLInputElement>('#dataset-slug')!
    expect(slug.value).toBe('dataset-2026-summary')
  })

  it('POSTs the trimmed body on submit', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ dataset: { id: 'NEW01' } }))
    const routerNavigate = vi.fn()
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate,
    })

    setInput(mount, '#dataset-title', '  My Dataset  ')
    clickRadio(mount, 'format', 'image/png')
    clickRadio(mount, 'visibility', 'private')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/publish/datasets',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          title: 'My Dataset',
          format: 'image/png',
          visibility: 'private',
          // The flip flag is always sent (a checkbox is explicitly
          // on/off so it can be toggled back off on edit); false is a
          // no-op the serializer treats the same as null.
          is_flipped_in_y: false,
        }),
      }),
    )
  })

  it('sends data_ref in the body when the input is non-empty', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ dataset: { id: 'NEW01' } }))
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'With ref')
    setInput(mount, '#dataset-data-ref', '  vimeo:123456  ')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))

    const sentBody = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<
      string,
      unknown
    >
    // Trim happens in the form's setIfPresent helper; whitespace
    // round-tripping cleanly is what keeps the column from
    // landing with a leading-space artifact.
    expect(sentBody.data_ref).toBe('vimeo:123456')
  })

  it('omits data_ref entirely when the input is empty (so the column lands NULL)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ dataset: { id: 'NEW01' } }))
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'No ref')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))

    const sentBody = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<
      string,
      unknown
    >
    expect(sentBody.data_ref).toBeUndefined()
  })

  it('omits the slug from the body when not manually overridden (server derives)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ dataset: { id: 'NEW01' } }))
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'Auto-Slug Title')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))

    const sentBody = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<
      string,
      unknown
    >
    expect(sentBody.slug).toBeUndefined()
  })

  it('includes the slug in the body when manually overridden', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ dataset: { id: 'NEW01' } }))
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'Any Title')
    setInput(mount, '#dataset-slug', 'my-custom')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))

    const sentBody = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<
      string,
      unknown
    >
    expect(sentBody.slug).toBe('my-custom')
  })

  it('navigates to the edit page on success so the publisher can upload', async () => {
    // On create the form jumps straight to /edit rather than the
    // read-only detail page. The detail page would force the
    // publisher to click Edit before the asset uploader appears,
    // which is two clicks of pure friction immediately after
    // saving — and the next user action is almost certainly to
    // upload bytes. Edit-mode saves keep the original navigate-to-
    // detail behavior; see dataset-form.ts:routerNavigate.
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ dataset: { id: 'NEW01' } }))
    const routerNavigate = vi.fn()
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate,
    })

    setInput(mount, '#dataset-title', 'A Title')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    expect(routerNavigate).toHaveBeenCalledWith('/publish/datasets/NEW01/edit')
  })

  it('renders per-field error messages on a 400 validation response', async () => {
    const errorsBody = {
      errors: [
        { field: 'title', code: 'too_short', message: 'Title must be at least 3 characters.' },
      ],
    }
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(errorsBody), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'Hi')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    const titleInput = mount.querySelector<HTMLInputElement>('#dataset-title')
    expect(titleInput?.getAttribute('aria-invalid')).toBe('true')
    expect(mount.textContent).toContain('Title must be at least 3 characters')
  })

  it('disables the Save button while saving', async () => {
    let resolveFetch: (r: Response) => void = () => {}
    const fetchFn = vi.fn().mockReturnValue(
      new Promise<Response>(r => {
        resolveFetch = r
      }),
    )
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'Some title')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))

    const btn = mount.querySelector<HTMLButtonElement>(
      'button.publisher-button-primary',
    )!
    expect(btn.disabled).toBe(true)
    expect(btn.textContent).toBe('Saving…')

    resolveFetch(jsonResponse({ dataset: { id: 'X' } }))
  })

  it('renders the top-level server-error card on a 5xx response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 503 }))
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'A title')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    expect(mount.querySelector('.publisher-error')?.getAttribute('role')).toBe('alert')
    expect(mount.textContent).toContain('server returned an error')
  })

  it('delegates session errors to the shared handler', async () => {
    sessionStorage.clear()
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    const navigate = vi.fn()
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      navigate,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'A title')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    expect(navigate).toHaveBeenCalledOnce()
  })

  it('renders the abstract textarea in edit mode by default', () => {
    renderDatasetNewPage(mount)
    const textarea = mount.querySelector<HTMLTextAreaElement>('#dataset-abstract')
    expect(textarea).not.toBeNull()
    expect(textarea?.tagName).toBe('TEXTAREA')
    expect(mount.querySelector('.publisher-form-markdown-preview')).toBeNull()
  })

  it('toggles to markdown preview when the Preview button is clicked', () => {
    renderDatasetNewPage(mount)
    setInputOnly(mount, '#dataset-abstract', '## Heading\n\nA **bold** paragraph.')
    const toggle = Array.from(
      mount.querySelectorAll<HTMLButtonElement>('button.publisher-form-toggle'),
    ).find(b => b.textContent === 'Preview')!
    toggle.click()

    const preview = mount.querySelector('.publisher-form-markdown-preview')
    expect(preview).not.toBeNull()
    expect(preview?.innerHTML).toContain('<h2>Heading</h2>')
    expect(preview?.innerHTML).toContain('<strong>bold</strong>')
  })

  it('toggle button text flips between Preview and Edit', () => {
    renderDatasetNewPage(mount)
    let toggle = mount.querySelector<HTMLButtonElement>('button.publisher-form-toggle')!
    expect(toggle.textContent).toBe('Preview')
    toggle.click()
    toggle = mount.querySelector<HTMLButtonElement>('button.publisher-form-toggle')!
    expect(toggle.textContent).toBe('Edit')
  })

  it('shows the empty-preview message when toggled to preview with no abstract', () => {
    renderDatasetNewPage(mount)
    const toggle = mount.querySelector<HTMLButtonElement>('button.publisher-form-toggle')!
    toggle.click()
    expect(mount.textContent).toContain('Nothing to preview yet')
  })

  it('preserves the abstract source across an edit ↔ preview round-trip', () => {
    renderDatasetNewPage(mount)
    const SOURCE = '## Hello\n\nThis is *markdown* text.'
    setInputOnly(mount, '#dataset-abstract', SOURCE)

    // Preview.
    let toggle = mount.querySelector<HTMLButtonElement>('button.publisher-form-toggle')!
    toggle.click()
    expect(mount.querySelector('.publisher-form-markdown-preview')).not.toBeNull()

    // Back to edit. Source should be intact.
    toggle = mount.querySelector<HTMLButtonElement>('button.publisher-form-toggle')!
    toggle.click()
    const textarea = mount.querySelector<HTMLTextAreaElement>('#dataset-abstract')!
    expect(textarea.value).toBe(SOURCE)
  })

  it('omits abstract from the body when blank', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ dataset: { id: 'X' } }))
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'A title')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<
      string,
      unknown
    >
    expect(body.abstract).toBeUndefined()
  })

  it('trims and includes abstract in the body when present', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ dataset: { id: 'X' } }))
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'A title')
    setInputOnly(mount, '#dataset-abstract', '  Hello there  ')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<
      string,
      unknown
    >
    expect(body.abstract).toBe('Hello there')
  })

  it('renders the organization field inside the identity card', () => {
    renderDatasetNewPage(mount)
    expect(mount.querySelector('#dataset-organization')).not.toBeNull()
  })

  it('renders the licensing card with all seven licensing/attribution fields', () => {
    renderDatasetNewPage(mount)
    expect(mount.querySelector('#dataset-license-spdx')).not.toBeNull()
    expect(mount.querySelector('#dataset-license-url')).not.toBeNull()
    expect(mount.querySelector('#dataset-license-statement')).not.toBeNull()
    expect(mount.querySelector('#dataset-attribution-text')).not.toBeNull()
    expect(mount.querySelector('#dataset-rights-holder')).not.toBeNull()
    expect(mount.querySelector('#dataset-doi')).not.toBeNull()
    expect(mount.querySelector('#dataset-citation')).not.toBeNull()
  })

  it('omits blank organization + licensing fields from the body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ dataset: { id: 'X' } }))
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'My dataset')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<
      string,
      unknown
    >
    expect(body.organization).toBeUndefined()
    expect(body.license_spdx).toBeUndefined()
    expect(body.license_url).toBeUndefined()
    expect(body.license_statement).toBeUndefined()
    expect(body.attribution_text).toBeUndefined()
    expect(body.rights_holder).toBeUndefined()
    expect(body.doi).toBeUndefined()
    expect(body.citation_text).toBeUndefined()
  })

  it('includes trimmed organization + licensing fields in the body when set', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ dataset: { id: 'X' } }))
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'A title')
    setInput(mount, '#dataset-organization', '  NOAA/PMEL  ')
    setInput(mount, '#dataset-license-spdx', 'CC0-1.0')
    setInput(mount, '#dataset-license-url', 'https://creativecommons.org/publicdomain/zero/1.0/')
    setInputOnly(mount, '#dataset-license-statement', '  Public domain  ')
    setInput(mount, '#dataset-attribution-text', 'Visualization by NOAA/PMEL')
    setInput(mount, '#dataset-rights-holder', 'U.S. Government')
    setInput(mount, '#dataset-doi', '10.5066/F7M906QJ')
    setInputOnly(mount, '#dataset-citation', 'NOAA PMEL, 2026.')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<
      string,
      unknown
    >
    expect(body.organization).toBe('NOAA/PMEL')
    expect(body.license_spdx).toBe('CC0-1.0')
    expect(body.license_url).toBe(
      'https://creativecommons.org/publicdomain/zero/1.0/',
    )
    expect(body.license_statement).toBe('Public domain')
    expect(body.attribution_text).toBe('Visualization by NOAA/PMEL')
    expect(body.rights_holder).toBe('U.S. Government')
    expect(body.doi).toBe('10.5066/F7M906QJ')
    expect(body.citation_text).toBe('NOAA PMEL, 2026.')
  })

  it('renders a per-corner bounding-box validation error inline', async () => {
    const errors = {
      errors: [
        {
          field: 'bounding_box.n',
          code: 'invalid_value',
          message: 'bounding_box.n must be in [-90, 90] (got 200).',
        },
      ],
    }
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(errors), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'A title')
    setInput(mount, '#dataset-bbox-n', '200')
    setInput(mount, '#dataset-bbox-s', '20')
    setInput(mount, '#dataset-bbox-w', '-10')
    setInput(mount, '#dataset-bbox-e', '30')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    const nInput = mount.querySelector<HTMLInputElement>('#dataset-bbox-n')
    expect(nInput?.getAttribute('aria-invalid')).toBe('true')
    expect(nInput?.getAttribute('aria-describedby')).toBe('dataset-bbox-n-err')
    expect(mount.querySelector('#dataset-bbox-n-err')?.textContent).toContain(
      'must be in [-90, 90]',
    )
  })

  it('renders per-field validation error on the licensing fields', async () => {
    const errors = {
      errors: [
        {
          field: 'license_url',
          code: 'invalid_url',
          message: 'License URL must be a valid URL.',
        },
      ],
    }
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(errors), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'A title')
    setInput(mount, '#dataset-license-url', 'not-a-url')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    const urlInput = mount.querySelector<HTMLInputElement>('#dataset-license-url')
    expect(urlInput?.getAttribute('aria-invalid')).toBe('true')
    expect(mount.textContent).toContain('License URL must be a valid URL')
  })

  it('renders the time-range card with split Date + Time inputs', () => {
    renderDatasetNewPage(mount)
    const startDate = mount.querySelector<HTMLInputElement>('#dataset-start-date')
    const startTime = mount.querySelector<HTMLInputElement>('#dataset-start-time')
    const endDate = mount.querySelector<HTMLInputElement>('#dataset-end-date')
    const endTime = mount.querySelector<HTMLInputElement>('#dataset-end-time')
    const period = mount.querySelector<HTMLInputElement>('#dataset-period')
    expect(startDate?.type).toBe('date')
    expect(startTime?.type).toBe('time')
    expect(endDate?.type).toBe('date')
    expect(endTime?.type).toBe('time')
    expect(period?.type).toBe('text')
  })

  it('omits time-range fields from the body when blank', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ dataset: { id: 'X' } }))
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'A title')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<
      string,
      unknown
    >
    expect(body.start_time).toBeUndefined()
    expect(body.end_time).toBeUndefined()
    expect(body.period).toBeUndefined()
  })

  it('composes date + time inputs into ISO 8601 UTC on submit', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ dataset: { id: 'X' } }))
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'A title')
    setInput(mount, '#dataset-start-date', '2026-04-01')
    setInput(mount, '#dataset-start-time', '08:30')
    setInput(mount, '#dataset-end-date', '2026-04-30')
    setInput(mount, '#dataset-end-time', '23:59')
    setInput(mount, '#dataset-period', 'P1M')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<
      string,
      unknown
    >
    // ISO 8601 with Z suffix — UTC offset depends on TZ.
    expect(body.start_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
    expect(body.end_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
    expect(body.period).toBe('P1M')
  })

  it('accepts a date-only entry (time defaults to midnight)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ dataset: { id: 'X' } }))
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'A title')
    setInput(mount, '#dataset-start-date', '2026-04-01')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<
      string,
      unknown
    >
    expect(body.start_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
  })

  it('renders the categorization card with keyword + tag chip inputs', () => {
    renderDatasetNewPage(mount)
    expect(mount.querySelector('#dataset-keywords')).not.toBeNull()
    expect(mount.querySelector('#dataset-tags')).not.toBeNull()
  })

  it('omits keywords + tags from the body when empty', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ dataset: { id: 'X' } }))
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'A title')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<
      string,
      unknown
    >
    expect(body.keywords).toBeUndefined()
    expect(body.tags).toBeUndefined()
  })

  it('includes keywords + tags in the body after the publisher commits chips', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ dataset: { id: 'X' } }))
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'A title')

    // Type into the keywords chip-input and press Enter twice.
    const keywords = mount.querySelector<HTMLInputElement>('#dataset-keywords')!
    keywords.value = 'climate'
    keywords.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    keywords.value = 'sst'
    keywords.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )

    const tags = mount.querySelector<HTMLInputElement>('#dataset-tags')!
    tags.value = 'featured'
    tags.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )

    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<
      string,
      unknown
    >
    expect(body.keywords).toEqual(['climate', 'sst'])
    expect(body.tags).toEqual(['featured'])
  })

  it('single-step: picking a file mints the draft first, then uploads against the new id', async () => {
    const fetchFn = vi
      .fn()
      // 1. create draft (POST) — ensureDraftId
      .mockResolvedValueOnce(jsonResponse({ dataset: { id: '01CREATEDDRAFTID000000000' } }, 201))
      // 2. /asset init (mock:true skips the XHR PUT)
      .mockResolvedValueOnce(
        jsonResponse(
          {
            upload_id: 'UP-1',
            kind: 'data',
            target: 'r2',
            r2: { method: 'PUT', url: 'https://mock-r2.localhost/put', headers: {}, key: 'k' },
            expires_at: 'soon',
            mock: true,
          },
          201,
        ),
      )
      // 3. /complete → direct image ref
      .mockResolvedValueOnce(jsonResponse({ dataset: { data_ref: 'r2:datasets/NEW/asset.png' } }))

    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'Single step')
    clickRadio(mount, 'format', 'image/png')

    // The data uploader's file input (first uploader in the data-upload
    // block). Picking a file drives the single-step flow.
    const input = mount.querySelector<HTMLInputElement>(
      '.publisher-form-data-upload .publisher-asset-uploader input[type="file"]',
    )!
    const file = new File(['png-bytes'], 'frame.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', {
      value: { 0: file, length: 1, item: (i: number) => (i === 0 ? file : null) } as unknown as FileList,
      configurable: true,
    })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0))

    // First call is the draft-create POST…
    expect(fetchFn.mock.calls[0][0]).toBe('/api/v1/publish/datasets')
    expect(fetchFn.mock.calls[0][1].method).toBe('POST')
    // …then the /asset mint targets the freshly-created id.
    expect(fetchFn.mock.calls[1][0]).toContain(
      '/api/v1/publish/datasets/01CREATEDDRAFTID000000000/asset',
    )
  })

  it('mounts the guided uploaders (single-step) alongside the manual inputs in create mode', () => {
    // Create mode mounts the data / thumbnail / legend uploaders even
    // though no row exists yet: picking a file mints the draft lazily
    // (via `ensureDatasetId`) and continues the upload against the new
    // row. The manual ref inputs stay as the paste-a-ref escape hatch.
    renderDatasetNewPage(mount)
    expect(mount.querySelector('#dataset-data-ref')).not.toBeNull()
    expect(mount.querySelector('#dataset-thumbnail-ref')).not.toBeNull()
    expect(mount.querySelector('#dataset-legend-ref')).not.toBeNull()
    // data + thumbnail + legend = three guided uploaders.
    expect(mount.querySelectorAll('.publisher-asset-uploader')).toHaveLength(3)
  })

  it('omits thumbnail_ref + legend_ref from the body when blank', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ dataset: { id: 'X' } }))
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'A title')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<
      string,
      unknown
    >
    expect(body.thumbnail_ref).toBeUndefined()
    expect(body.legend_ref).toBeUndefined()
  })

  it('includes trimmed thumbnail_ref + legend_ref in the body when set', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ dataset: { id: 'X' } }))
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'A title')
    setInput(mount, '#dataset-thumbnail-ref', '  r2:datasets/X/thumbnail.png  ')
    setInput(mount, '#dataset-legend-ref', '  r2:datasets/X/legend.png  ')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<
      string,
      unknown
    >
    expect(body.thumbnail_ref).toBe('r2:datasets/X/thumbnail.png')
    expect(body.legend_ref).toBe('r2:datasets/X/legend.png')
  })

  it('renders the geography & projection card fields', () => {
    renderDatasetNewPage(mount)
    expect(mount.querySelector('#dataset-bbox-n')).not.toBeNull()
    expect(mount.querySelector('#dataset-bbox-s')).not.toBeNull()
    expect(mount.querySelector('#dataset-bbox-w')).not.toBeNull()
    expect(mount.querySelector('#dataset-bbox-e')).not.toBeNull()
    expect(mount.querySelector('#dataset-lon-origin')).not.toBeNull()
    expect(mount.querySelector('#dataset-flipped-y')).not.toBeNull()
    expect(mount.querySelector('#dataset-celestial-body')).not.toBeNull()
    expect(mount.querySelector('#dataset-radius-mi')).not.toBeNull()
  })

  it('sends bounding_box + projection fields when set', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ dataset: { id: 'X' } }))
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'Regional Mars set')
    setInput(mount, '#dataset-bbox-n', '60')
    setInput(mount, '#dataset-bbox-s', '20')
    setInput(mount, '#dataset-bbox-w', '-10')
    setInput(mount, '#dataset-bbox-e', '30')
    setInput(mount, '#dataset-lon-origin', '180')
    mount.querySelector<HTMLInputElement>('#dataset-flipped-y')!.click()
    setInput(mount, '#dataset-celestial-body', 'Mars')
    setInput(mount, '#dataset-radius-mi', '2106')
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<string, unknown>
    expect(body.bounding_box).toEqual({ n: 60, s: 20, w: -10, e: 30 })
    expect(body.lon_origin).toBe(180)
    expect(body.is_flipped_in_y).toBe(true)
    expect(body.celestial_body).toBe('Mars')
    expect(body.radius_mi).toBe(2106)
  })

  it('omits bounding_box when not all four corners are filled', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ dataset: { id: 'X' } }))
    renderDatasetNewPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate: vi.fn(),
    })

    setInput(mount, '#dataset-title', 'Partial box')
    setInput(mount, '#dataset-bbox-n', '60')
    setInput(mount, '#dataset-bbox-s', '20')
    setInput(mount, '#dataset-bbox-w', '-10')
    // East left blank.
    submitForm(mount)
    await new Promise(r => setTimeout(r, 0))

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<string, unknown>
    expect(body.bounding_box).toBeUndefined()
  })

  it('Cancel link routes back to /publish/datasets via SPA navigation', () => {
    const routerNavigate = vi.fn()
    renderDatasetNewPage(mount, { routerNavigate })

    const cancel = mount.querySelector<HTMLAnchorElement>('a.publisher-button-secondary')!
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    cancel.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(routerNavigate).toHaveBeenCalledWith('/publish/datasets')
  })
})
