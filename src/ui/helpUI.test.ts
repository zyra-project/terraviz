import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock chatUI so importing helpUI doesn't pull in the full chat module
vi.mock('./chatUI', () => ({
  closeChat: vi.fn(),
}))

// Mock the general feedback service so we can assert the payload
const submitMock = vi.fn()
vi.mock('../services/generalFeedbackService', () => ({
  submitGeneralFeedback: (...args: unknown[]) => submitMock(...args),
}))

// Mock the screenshot service
vi.mock('../services/screenshotService', () => ({
  captureFullScreen: vi.fn(async () => 'data:image/jpeg;base64,fake'),
  captureGlobeScreenshot: vi.fn(async () => 'data:image/jpeg;base64,fake-globe'),
}))

// Import after mocks are set up
import { initHelpUI, openHelp, closeHelp, toggleHelp, setActiveDataset } from './helpUI'

function setupDom(): void {
  document.body.innerHTML = `
    <button id="help-trigger" aria-expanded="false">
      <span class="help-trigger-icon">?</span>
      <span class="help-trigger-label">Help</span>
    </button>
    <div id="help-panel" class="hidden" role="dialog" aria-hidden="true">
      <div id="help-header">
        <span id="help-title">Help</span>
        <button id="help-close">×</button>
      </div>
      <div class="help-tablist" role="tablist">
        <button class="help-tab active" role="tab" data-tab="guide" id="help-tab-guide" aria-selected="true">Guide</button>
        <button class="help-tab" role="tab" data-tab="feedback" id="help-tab-feedback" aria-selected="false" tabindex="-1">Feedback</button>
      </div>
      <div id="help-tabpanel-guide" class="help-tabpanel" role="tabpanel"></div>
      <div id="help-tabpanel-feedback" class="help-tabpanel hidden" role="tabpanel"></div>
    </div>
  `
}

describe('helpUI', () => {
  beforeEach(() => {
    setupDom()
    submitMock.mockReset()
    initHelpUI()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    closeHelp()
  })

  describe('panel open/close', () => {
    it('opens when the trigger is clicked', () => {
      const trigger = document.getElementById('help-trigger')!
      trigger.click()
      const panel = document.getElementById('help-panel')!
      expect(panel.classList.contains('hidden')).toBe(false)
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
    })

    it('closes when Escape is pressed', () => {
      openHelp()
      const panel = document.getElementById('help-panel')!
      expect(panel.classList.contains('hidden')).toBe(false)

      const evt = new KeyboardEvent('keydown', { key: 'Escape' })
      document.dispatchEvent(evt)
      expect(panel.classList.contains('hidden')).toBe(true)
    })

    it('toggleHelp switches state', () => {
      const panel = document.getElementById('help-panel')!
      toggleHelp()
      expect(panel.classList.contains('hidden')).toBe(false)
      toggleHelp()
      expect(panel.classList.contains('hidden')).toBe(true)
    })

    it('renders guide content on first open', () => {
      openHelp()
      const guide = document.getElementById('help-tabpanel-guide')!
      expect(guide.innerHTML).toContain('Navigating the globe')
      expect(guide.innerHTML).toContain('Guided tours')
      expect(guide.innerHTML).toContain('Talking to Orbit')
    })
  })

  describe('tab switching', () => {
    beforeEach(() => openHelp())

    it('updates aria-selected when a tab is clicked', () => {
      const feedbackTab = document.getElementById('help-tab-feedback')!
      feedbackTab.click()
      expect(feedbackTab.getAttribute('aria-selected')).toBe('true')
      const guideTab = document.getElementById('help-tab-guide')!
      expect(guideTab.getAttribute('aria-selected')).toBe('false')
    })

    it('shows the feedback panel body when the feedback tab is active', () => {
      document.getElementById('help-tab-feedback')!.click()
      const panel = document.getElementById('help-tabpanel-feedback')!
      expect(panel.classList.contains('hidden')).toBe(false)
      // Feedback form rendered
      expect(document.getElementById('help-feedback-form')).toBeTruthy()
      expect(document.getElementById('help-feedback-message')).toBeTruthy()
    })

    it('arrow keys navigate between tabs', () => {
      const guideTab = document.getElementById('help-tab-guide')!
      const feedbackTab = document.getElementById('help-tab-feedback')!
      // Ensure the guide tab is active before the arrow-key test
      guideTab.click()
      expect(guideTab.getAttribute('aria-selected')).toBe('true')

      const evt = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
      guideTab.dispatchEvent(evt)
      expect(feedbackTab.getAttribute('aria-selected')).toBe('true')
      expect(guideTab.getAttribute('aria-selected')).toBe('false')
    })
  })

  describe('feedback form validation', () => {
    beforeEach(() => {
      openHelp()
      document.getElementById('help-tab-feedback')!.click()
    })

    it('rejects empty/short messages', async () => {
      const form = document.getElementById('help-feedback-form') as HTMLFormElement
      const textarea = document.getElementById('help-feedback-message') as HTMLTextAreaElement
      textarea.value = 'too short'
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      // Wait a tick for async handler
      await Promise.resolve()
      expect(submitMock).not.toHaveBeenCalled()
      const status = document.getElementById('help-feedback-status')!
      expect(status.textContent).toMatch(/at least/)
      expect(status.classList.contains('error')).toBe(true)
    })

    it('submits a valid payload and reports success', async () => {
      submitMock.mockResolvedValue({ ok: true, status: 200 })
      setActiveDataset('INTERNAL_TEST_001')

      const form = document.getElementById('help-feedback-form') as HTMLFormElement
      const textarea = document.getElementById('help-feedback-message') as HTMLTextAreaElement
      const contact = document.getElementById('help-feedback-contact') as HTMLInputElement
      textarea.value = 'Here is a detailed bug report with enough characters.'
      contact.value = 'user@example.com'
      // Select "feature"
      const featureRadio = form.querySelector<HTMLInputElement>('input[name="help-kind"][value="feature"]')!
      featureRadio.checked = true

      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()

      expect(submitMock).toHaveBeenCalledTimes(1)
      const payload = submitMock.mock.calls[0][0]
      expect(payload.kind).toBe('feature')
      expect(payload.message).toBe('Here is a detailed bug report with enough characters.')
      expect(payload.contact).toBe('user@example.com')
      expect(payload.datasetId).toBe('INTERNAL_TEST_001')
      expect(payload.platform).toBe('web')
      // Screenshot not attached since checkbox was not checked
      expect(payload.screenshot).toBeUndefined()

      // Status updated on success (wait for state to flush)
      await new Promise(resolve => setTimeout(resolve, 0))
      const status = document.getElementById('help-feedback-status')!
      expect(status.textContent).toMatch(/Thanks/)
      expect(status.classList.contains('success')).toBe(true)
    })

    it('attaches a screenshot when the checkbox is checked', async () => {
      submitMock.mockResolvedValue({ ok: true, status: 200 })

      const form = document.getElementById('help-feedback-form') as HTMLFormElement
      const textarea = document.getElementById('help-feedback-message') as HTMLTextAreaElement
      const screenshotBox = document.getElementById('help-feedback-screenshot') as HTMLInputElement
      textarea.value = 'A bug report with enough length to pass the validation.'
      screenshotBox.checked = true

      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()

      const payload = submitMock.mock.calls[0][0]
      expect(payload.screenshot).toBe('data:image/jpeg;base64,fake')
    })

    it('surfaces a server error message on failure', async () => {
      submitMock.mockResolvedValue({ ok: false, status: 429, error: 'Rate limit exceeded' })

      const form = document.getElementById('help-feedback-form') as HTMLFormElement
      const textarea = document.getElementById('help-feedback-message') as HTMLTextAreaElement
      textarea.value = 'Another detailed bug report with ample characters.'

      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))

      const status = document.getElementById('help-feedback-status')!
      expect(status.textContent).toContain('Rate limit exceeded')
      expect(status.classList.contains('error')).toBe(true)
    })
  })
})
