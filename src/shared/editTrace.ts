// Opt-in, bounded post-drag diagnosis; disabled unless the renderer requests it.
// Only fixed stage names, generated trace IDs and numeric measurements go here.
export const EDIT_TRACE_PREFIX = '[DEBUG-edit-latency]'
export const EDIT_TRACE_ARG = '__debugEditTraceId'

export function editTraceId(value: unknown): string | undefined {
  return typeof value === 'string' && /^edit-[a-f0-9-]{36}$/.test(value) ? value : undefined
}

export class EditTrace {
  readonly startedAt = Date.now()
  readonly start = performance.now()
  private spans: { stage: string; offsetMs: number; durationMs: number; ok: boolean }[] = []
  private facts: Record<string, number | boolean> = {}
  constructor(readonly id: string, readonly phase: string) {}

  fact(key: string, value: number | boolean): void { this.facts[key] = value }
  span(stage: string): (ok?: boolean) => void {
    const start = performance.now()
    let finished = false
    return (ok = true) => {
      if (finished) return
      finished = true
      if (this.spans.length < 64) this.spans.push({ stage,
        offsetMs: start - this.start, durationMs: performance.now() - start, ok })
    }
  }
  measure<T>(stage: string, work: () => T): T {
    const end = this.span(stage)
    try { const result = work(); end(); return result }
    catch (error) { end(false); throw error }
  }
  report(ok = true): void {
    try {
      console.info(EDIT_TRACE_PREFIX + ' ' + JSON.stringify({ traceId: this.id, phase: this.phase,
        startedAt: this.startedAt, durationMs: performance.now() - this.start, ok,
        spans: this.spans, ...this.facts }))
    } catch { /* Diagnosis must never change an edit's result. */ }
  }
}

// Synchronous scope ONLY: never retained over an await. Concurrent IPC requests
// cannot inherit another command's trace; nested calls restore their parent.
let current: EditTrace | undefined
export function currentEditTrace(): EditTrace | undefined { return current }
export function measureEditStage<T>(stage: string, work: () => T): T {
  return current ? current.measure(stage, work) : work()
}
export function runEditTrace<T>(id: string | undefined, phase: string, work: () => T): T {
  if (!id) return work()
  const previous = current
  const trace = new EditTrace(id, phase)
  current = trace
  let ok = false
  try { const value = work(); ok = true; return value }
  finally { current = previous; trace.report(ok) }
}
