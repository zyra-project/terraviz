/**
 * Tour-engine telemetry tests.
 *
 * Covers the `tour_started` / `tour_task_fired` / `tour_paused` /
 * `tour_resumed` / `tour_ended` flow without needing a renderer or
 * the full task-executor surface — uses `pauseSeconds: 0` tasks
 * which resolve on the next microtask, so the engine can run a
 * 3-task tour to completion synchronously enough for vitest's
 * fake timers to drive.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Stub tourUI so showTourQuestion captures its params (for the
// question-answer tests) and so the other tour-UI helpers used
// by the engine are no-ops in the unit-test environment.
let capturedQuestion: Parameters<typeof import('../ui/tourUI').showTourQuestion>[0] | null = null
vi.mock('../ui/tourUI', () => ({
  showTourTextBox: vi.fn(),
  hideTourTextBox: vi.fn(),
  hideAllTourTextBoxes: vi.fn(),
  showTourImage: vi.fn(),
  hideTourImage: vi.fn(),
  hideAllTourImages: vi.fn(),
  showTourVideo: vi.fn(),
  hideTourVideo: vi.fn(),
  hideAllTourVideos: vi.fn(),
  showTourPopup: vi.fn(),
  hideTourPopup: vi.fn(),
  hideAllTourPopups: vi.fn(),
  showTourQuestion: vi.fn((params) => {
    capturedQuestion = params
  }),
  hideAllTourQuestions: vi.fn(),
  showTourControls: vi.fn(),
  hideTourControls: vi.fn(),
  updateTourPlayState: vi.fn(),
  showTourLegend: vi.fn(),
  hideTourLegend: vi.fn(),
  updateTourProgress: vi.fn(),
}))

import { TourEngine } from './tourEngine'
import { resetForTests, __peek } from '../analytics/emitter'
import { setTier } from '../analytics/config'
import type { TourCallbacks, TourFile } from '../types'

function noopCallbacks(): TourCallbacks {
  return {
    loadDataset: vi.fn(async () => {}),
    unloadAllDatasets: vi.fn(async () => {}),
    unloadDatasetAt: vi.fn(async () => {}),
    setEnvView: vi.fn(async () => {}),
    getRenderer: vi.fn(() => ({} as unknown as ReturnType<TourCallbacks['getRenderer']>)),
    getAllRenderers: vi.fn(() => []),
    getPrimarySlot: vi.fn(() => 0),
    togglePlayPause: vi.fn(() => {}),
    isPlaying: vi.fn(() => false),
    setPlaybackRate: vi.fn(() => {}),
    onTourEnd: vi.fn(() => {}),
    onStop: vi.fn(() => {}),
    announce: vi.fn(() => {}),
    resolveMediaUrl: vi.fn((s) => s),
  }
}

const SAMPLE_TOUR: TourFile = {
  tourTasks: [
    { pauseSeconds: 0 },
    { pauseSeconds: 0 },
    { pauseSeconds: 0 },
  ],
}

const META = {
  tourId: 'tour-test',
  tourTitle: 'Test Tour',
  source: 'browse' as const,
}

beforeEach(() => {
  localStorage.clear()
  resetForTests()
  setTier('research') // Tier B events need the research tier
  capturedQuestion = null
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TourEngine — telemetry events', () => {
  it('emits tour_started exactly once per run with task_count', async () => {
    const engine = new TourEngine(SAMPLE_TOUR, noopCallbacks(), { meta: META })
    void engine.play()
    // Yield a microtask so play() can fire tour_started before we peek.
    await Promise.resolve()
    const starts = __peek().filter((e) => e.event_type === 'tour_started')
    expect(starts).toHaveLength(1)
    const e = starts[0]
    if (e.event_type !== 'tour_started') throw new Error('unreachable')
    expect(e.tour_id).toBe('tour-test')
    expect(e.tour_title).toBe('Test Tour')
    expect(e.source).toBe('browse')
    expect(e.task_count).toBe(3)
    engine.stop()
  })

  it('emits tour_task_fired for every task with the correct task_index', async () => {
    const engine = new TourEngine(SAMPLE_TOUR, noopCallbacks(), { meta: META })
    await engine.play()
    const taskFires = __peek().filter((e) => e.event_type === 'tour_task_fired')
    expect(taskFires).toHaveLength(3)
    expect(taskFires.map((e) => (e.event_type === 'tour_task_fired' ? e.task_index : -1))).toEqual([0, 1, 2])
    for (const ev of taskFires) {
      if (ev.event_type !== 'tour_task_fired') continue
      expect(ev.task_type).toBe('pauseSeconds')
      expect(ev.tour_id).toBe('tour-test')
    }
  })

  it('reports task_dwell_ms = 0 for the first task', async () => {
    // Without the explicit `index === 0` guard, the first task's
    // dwell would be the small interval between play() setting
    // taskStartedAt and the run loop reaching task 0 — typically a
    // few ms in tests, more under load. Dashboards expect 0.
    const engine = new TourEngine(SAMPLE_TOUR, noopCallbacks(), { meta: META })
    await engine.play()
    const taskFires = __peek().filter((e) => e.event_type === 'tour_task_fired')
    const firstTask = taskFires.find(
      (e) => e.event_type === 'tour_task_fired' && e.task_index === 0,
    )
    if (!firstTask || firstTask.event_type !== 'tour_task_fired') throw new Error('unreachable')
    expect(firstTask.task_dwell_ms).toBe(0)
  })

  it('emits tour_paused with reason=user on pause()', async () => {
    const engine = new TourEngine(SAMPLE_TOUR, noopCallbacks(), { meta: META })
    void engine.play()
    await Promise.resolve()
    engine.pause()
    const pauses = __peek().filter((e) => e.event_type === 'tour_paused')
    expect(pauses).toHaveLength(1)
    const ev = pauses[0]
    if (ev.event_type !== 'tour_paused') throw new Error('unreachable')
    expect(ev.reason).toBe('user')
    expect(ev.tour_id).toBe('tour-test')
    engine.stop()
  })

  it('emits tour_resumed with pause_ms ≥ 0 when play() resumes from pause', async () => {
    const engine = new TourEngine(SAMPLE_TOUR, noopCallbacks(), { meta: META })
    void engine.play()
    await Promise.resolve()
    engine.pause()
    await new Promise((r) => setTimeout(r, 5))
    void engine.play()
    await Promise.resolve()
    const resumes = __peek().filter((e) => e.event_type === 'tour_resumed')
    expect(resumes).toHaveLength(1)
    const ev = resumes[0]
    if (ev.event_type !== 'tour_resumed') throw new Error('unreachable')
    expect(ev.pause_ms).toBeGreaterThanOrEqual(0)
    engine.stop()
  })

  it('emits tour_ended with outcome=abandoned on stop()', () => {
    const engine = new TourEngine(SAMPLE_TOUR, noopCallbacks(), { meta: META })
    void engine.play()
    engine.stop()
    const ends = __peek().filter((e) => e.event_type === 'tour_ended')
    expect(ends).toHaveLength(1)
    const ev = ends[0]
    if (ev.event_type !== 'tour_ended') throw new Error('unreachable')
    expect(ev.outcome).toBe('abandoned')
    expect(ev.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('emits tour_ended with outcome=completed on natural end', async () => {
    const engine = new TourEngine(SAMPLE_TOUR, noopCallbacks(), { meta: META })
    await engine.play()
    const ends = __peek().filter((e) => e.event_type === 'tour_ended')
    expect(ends).toHaveLength(1)
    const ev = ends[0]
    if (ev.event_type !== 'tour_ended') throw new Error('unreachable')
    expect(ev.outcome).toBe('completed')
  })

  it('does not emit tour_started until play() is called', () => {
    new TourEngine(SAMPLE_TOUR, noopCallbacks(), { meta: META })
    expect(__peek().filter((e) => e.event_type === 'tour_started')).toHaveLength(0)
  })

  it('falls back to tour_id="unknown" when no meta is supplied', async () => {
    const engine = new TourEngine(SAMPLE_TOUR, noopCallbacks())
    void engine.play()
    await Promise.resolve()
    const starts = __peek().filter((e) => e.event_type === 'tour_started')
    expect(starts).toHaveLength(1)
    const ev = starts[0]
    if (ev.event_type !== 'tour_started') throw new Error('unreachable')
    expect(ev.tour_id).toBe('unknown')
    engine.stop()
  })
})

describe('TourEngine — tour_question_answered', () => {
  const QUESTION_TOUR: TourFile = {
    tourTasks: [
      {
        question: {
          id: 'q-arctic-1',
          imgQuestionFilename: 'q.png',
          imgAnswerFilename: 'a.png',
          numberOfAnswers: 4,
          correctAnswerIndex: 2,
        },
      },
    ],
  }

  it('emits tour_question_answered with response_ms when the user picks correctly', async () => {
    const engine = new TourEngine(QUESTION_TOUR, noopCallbacks(), { meta: META })
    void engine.play()
    while (!capturedQuestion) await Promise.resolve()
    capturedQuestion.onAnswered?.(2)

    const evs = __peek().filter((e) => e.event_type === 'tour_question_answered')
    expect(evs).toHaveLength(1)
    const ev = evs[0]
    if (ev.event_type !== 'tour_question_answered') throw new Error('unreachable')
    expect(ev.tour_id).toBe('tour-test')
    expect(ev.question_id).toBe('q-arctic-1')
    expect(ev.task_index).toBe(0)
    expect(ev.choice_count).toBe(4)
    expect(ev.chosen_index).toBe(2)
    expect(ev.correct_index).toBe(2)
    expect(ev.was_correct).toBe(true)
    expect(ev.response_ms).toBeGreaterThanOrEqual(0)

    capturedQuestion.onComplete()
    engine.stop()
  })

  it('records was_correct=false on a wrong answer', async () => {
    const engine = new TourEngine(QUESTION_TOUR, noopCallbacks(), { meta: META })
    void engine.play()
    while (!capturedQuestion) await Promise.resolve()
    capturedQuestion.onAnswered?.(0)

    const ev = __peek().find((e) => e.event_type === 'tour_question_answered')
    if (!ev || ev.event_type !== 'tour_question_answered') throw new Error('unreachable')
    expect(ev.chosen_index).toBe(0)
    expect(ev.was_correct).toBe(false)

    capturedQuestion.onComplete()
    engine.stop()
  })

  it('dedupes — a second onAnswered call (e.g. VR + 2D both firing) does not double-emit', async () => {
    const engine = new TourEngine(QUESTION_TOUR, noopCallbacks(), { meta: META })
    void engine.play()
    while (!capturedQuestion) await Promise.resolve()
    capturedQuestion.onAnswered?.(2)
    capturedQuestion.onAnswered?.(1) // second call should be ignored

    const evs = __peek().filter((e) => e.event_type === 'tour_question_answered')
    expect(evs).toHaveLength(1)
    const ev = evs[0]
    if (ev.event_type !== 'tour_question_answered') throw new Error('unreachable')
    expect(ev.chosen_index).toBe(2)

    capturedQuestion.onComplete()
    engine.stop()
  })

  it('does not emit when the user skips the question (no onAnswered call)', async () => {
    const engine = new TourEngine(QUESTION_TOUR, noopCallbacks(), { meta: META })
    void engine.play()
    while (!capturedQuestion) await Promise.resolve()
    engine.stop()
    expect(__peek().filter((e) => e.event_type === 'tour_question_answered')).toHaveLength(0)
  })

  it('does not emit when the tier is below research', async () => {
    setTier('essential') // Tier A only — tour_question_answered is Tier B
    const engine = new TourEngine(QUESTION_TOUR, noopCallbacks(), { meta: META })
    void engine.play()
    while (!capturedQuestion) await Promise.resolve()
    capturedQuestion.onAnswered?.(2)
    expect(__peek().filter((e) => e.event_type === 'tour_question_answered')).toHaveLength(0)
    capturedQuestion.onComplete()
    engine.stop()
  })
})
