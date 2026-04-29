/**
 * Asynchronous job queue interface — Phase 1b.
 *
 * The plan ships a `Queue` consumer for embedding work, sphere-
 * thumbnail rendering, and federation fan-out (see "Local
 * development" → Queues in `CATALOG_BACKEND_PLAN.md`). Cloudflare
 * Queues has no production-quality local emulation today, so the
 * dev path runs the same job functions inline against the request's
 * `ctx.waitUntil` — same Worker, no separate consumer. When Queues
 * lands in a later phase the binding gets a third implementation
 * here and the call sites do not change.
 *
 * Three implementations:
 *
 *   - `WaitUntilJobQueue` — production / dev. Calls
 *     `ctx.waitUntil(handler(payload))` so the response returns
 *     immediately while the job continues running on the same
 *     isolate. Errors are logged via `console.error`; surfacing
 *     them as audit_events lives in a Phase 4 follow-on.
 *
 *   - `SyncJobQueue` — tests that want to verify the side effects
 *     end-to-end. `enqueue` awaits the handler inline; assertions
 *     run against R2 / D1 mutations after the call returns.
 *
 *   - `CapturingJobQueue` — tests that only want to verify "the
 *     route enqueued the right job with the right payload" without
 *     exercising the job body. Records `(name, payload)` tuples
 *     and never invokes the handler.
 *
 * The handler signature is `(env, payload) => Promise<void>`. Jobs
 * that need additional services (R2, fetch impl) read them from
 * `env`. This keeps the queue interface generic — it doesn't know
 * what catalog-specific bindings exist.
 */

export interface JobHandler<T> {
  (env: unknown, payload: T): Promise<unknown>
}

export interface JobQueue {
  enqueue<T>(name: string, handler: JobHandler<T>, payload: T): Promise<void>
}

/**
 * Production / dev queue. Schedules the handler against the
 * request's `ctx.waitUntil` so the response goes back without
 * blocking; the Worker keeps the handler running past the response
 * up to its CPU/wall budget.
 */
export class WaitUntilJobQueue implements JobQueue {
  constructor(
    private readonly env: unknown,
    private readonly waitUntil: (p: Promise<unknown>) => void,
  ) {}

  async enqueue<T>(name: string, handler: JobHandler<T>, payload: T): Promise<void> {
    this.waitUntil(
      handler(this.env, payload).catch(err => {
        // Job failures don't fail the originating request, but the
        // operator wants to know. Workers Logs picks this up.
        // eslint-disable-next-line no-console
        console.error(`[job-queue] ${name} failed:`, err)
      }),
    )
  }
}

/**
 * Test queue that runs handlers inline so tests can assert on the
 * side effects synchronously. Records `(name, payload)` tuples
 * alongside execution for visibility.
 */
export class SyncJobQueue implements JobQueue {
  public readonly records: Array<{ name: string; payload: unknown }> = []
  constructor(private readonly env: unknown) {}

  async enqueue<T>(name: string, handler: JobHandler<T>, payload: T): Promise<void> {
    this.records.push({ name, payload })
    await handler(this.env, payload)
  }
}

/**
 * Test queue that records the call but does NOT run the handler.
 * Used when a route's responsibility is "enqueue the right job",
 * not "the job's body works" (which is tested separately on the
 * job function directly).
 */
export class CapturingJobQueue implements JobQueue {
  public readonly records: Array<{ name: string; payload: unknown }> = []

  async enqueue<T>(_name: string, _handler: JobHandler<T>, payload: T): Promise<void> {
    this.records.push({ name: _name, payload })
  }
}
