import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  hideCatalogTabs,
  initCatalogTabs,
  setActiveCatalogTab,
  showCatalogTabs,
} from './catalogTabsUI'

function setupDom(): void {
  document.body.innerHTML = `
    <div id="container">
      <div id="ui"></div>
    </div>
  `
}

describe('catalogTabsUI', () => {
  beforeEach(() => {
    setupDom()
  })

  it('mounts a tab control under #ui with both tabs', () => {
    initCatalogTabs({ onSelectCatalog: vi.fn(), onSelectSphere: vi.fn() })
    const host = document.getElementById('catalog-tabs')
    expect(host).not.toBeNull()
    expect(host!.parentElement?.id).toBe('ui')
    expect(host!.querySelector('#catalog-tab-catalog')).not.toBeNull()
    expect(host!.querySelector('#catalog-tab-sphere')).not.toBeNull()
  })

  it('starts hidden — caller decides when to reveal', () => {
    initCatalogTabs({ onSelectCatalog: vi.fn(), onSelectSphere: vi.fn() })
    expect(document.getElementById('catalog-tabs')?.classList.contains('hidden')).toBe(true)
  })

  it('showCatalogTabs reveals the control; hideCatalogTabs hides it', () => {
    initCatalogTabs({ onSelectCatalog: vi.fn(), onSelectSphere: vi.fn() })
    showCatalogTabs()
    expect(document.getElementById('catalog-tabs')?.classList.contains('hidden')).toBe(false)
    hideCatalogTabs()
    expect(document.getElementById('catalog-tabs')?.classList.contains('hidden')).toBe(true)
  })

  it('uses role="group" + aria-pressed (segmented toggle, not tablist)', () => {
    initCatalogTabs({ onSelectCatalog: vi.fn(), onSelectSphere: vi.fn() })
    const host = document.getElementById('catalog-tabs')!
    expect(host.getAttribute('role')).toBe('group')
    // Buttons should not advertise tab semantics — no role="tab",
    // no aria-controls (no matching tabpanels exist).
    const catalogBtn = document.getElementById('catalog-tab-catalog')!
    expect(catalogBtn.getAttribute('role')).toBeNull()
    expect(catalogBtn.getAttribute('aria-controls')).toBeNull()
  })

  it('setActiveCatalogTab marks the chosen tab active and sets aria-pressed', () => {
    initCatalogTabs({ onSelectCatalog: vi.fn(), onSelectSphere: vi.fn() })
    setActiveCatalogTab('catalog')
    const catalogBtn = document.getElementById('catalog-tab-catalog')!
    const sphereBtn = document.getElementById('catalog-tab-sphere')!
    expect(catalogBtn.classList.contains('active')).toBe(true)
    expect(catalogBtn.getAttribute('aria-pressed')).toBe('true')
    expect(sphereBtn.classList.contains('active')).toBe(false)
    expect(sphereBtn.getAttribute('aria-pressed')).toBe('false')

    setActiveCatalogTab('sphere')
    expect(catalogBtn.classList.contains('active')).toBe(false)
    expect(catalogBtn.getAttribute('aria-pressed')).toBe('false')
    expect(sphereBtn.classList.contains('active')).toBe(true)
    expect(sphereBtn.getAttribute('aria-pressed')).toBe('true')
  })

  it('renders tab labels via escapeHtml (markup-injection safe)', () => {
    initCatalogTabs({ onSelectCatalog: vi.fn(), onSelectSphere: vi.fn() })
    const catalogBtn = document.getElementById('catalog-tab-catalog')!
    // Sanity check: visible text is the plain locale string, no
    // child elements (would indicate the label rendered as raw HTML).
    expect(catalogBtn.children.length).toBe(0)
    expect(catalogBtn.textContent?.trim()).toBe('Catalog')
  })

  it('clicking Catalog calls onSelectCatalog', () => {
    const onCatalog = vi.fn()
    const onSphere = vi.fn()
    initCatalogTabs({ onSelectCatalog: onCatalog, onSelectSphere: onSphere })
    document.getElementById('catalog-tab-catalog')!.click()
    expect(onCatalog).toHaveBeenCalledTimes(1)
    expect(onSphere).not.toHaveBeenCalled()
  })

  it('clicking Sphere calls onSelectSphere', () => {
    const onCatalog = vi.fn()
    const onSphere = vi.fn()
    initCatalogTabs({ onSelectCatalog: onCatalog, onSelectSphere: onSphere })
    document.getElementById('catalog-tab-sphere')!.click()
    expect(onSphere).toHaveBeenCalledTimes(1)
    expect(onCatalog).not.toHaveBeenCalled()
  })

  it('is idempotent — re-calling initCatalogTabs does not double-mount', () => {
    initCatalogTabs({ onSelectCatalog: vi.fn(), onSelectSphere: vi.fn() })
    initCatalogTabs({ onSelectCatalog: vi.fn(), onSelectSphere: vi.fn() })
    expect(document.querySelectorAll('#catalog-tabs').length).toBe(1)
  })
})
