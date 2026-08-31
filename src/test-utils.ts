// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// doc-exempt: test infrastructure, not an app module — same category as
// test-setup.ts, which check-doc-coverage excludes by name.

/**
 * Wait for a signal instead of guessing how long it takes.
 *
 * The pattern this replaces drained a fixed number of event-loop turns
 * and then asserted:
 *
 *     for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0))
 *     expect(fetchFn.mock.calls[1][0]).toContain('/asset')
 *
 * The count is a guess about how many turns the chain needs. On an idle
 * machine it is enough; on a loaded CI runner it sometimes is not, and
 * the assertion fires against a half-finished chain — reported as
 * `Cannot read properties of undefined`, which names neither the race
 * nor what was being waited for. Raising the count moves the threshold
 * rather than removing it.
 *
 * `until` polls, so a slow machine waits longer and a genuinely broken
 * chain still fails — at the timeout, saying what it was waiting for.
 *
 * It also improves the *negative* assertions that follow a wait. Given
 * `until(() => onUploaded.mock.calls.length === 1)` before
 * `expect(xhrFactory).not.toHaveBeenCalled()`, the second assertion
 * means "the chain reached its end state without touching the XHR
 * path". After a fixed drain it only meant "nothing happened in the
 * however-many turns we waited", which is weaker and machine-dependent.
 */
export async function until(
  condition: () => boolean,
  description?: string,
  { timeoutMs = 2_000, intervalMs = 1 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  // A condition that indexes into a not-yet-populated array throws
  // rather than returning false. Treat that as "not yet", but keep the
  // error: if it is still throwing at the deadline, that message is far
  // more useful than a bare timeout.
  let lastError: unknown

  for (;;) {
    try {
      if (condition()) return
      lastError = undefined
    } catch (err) {
      lastError = err
    }

    if (Date.now() >= deadline) {
      const what = description ?? String(condition).replace(/\s+/g, ' ').trim()
      const because =
        lastError instanceof Error ? ` — condition kept throwing: ${lastError.message}` : ''
      throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}${because}`)
    }

    await new Promise(r => setTimeout(r, intervalMs))
  }
}
