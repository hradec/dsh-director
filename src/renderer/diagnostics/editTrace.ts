import { EditTrace } from '../../shared/editTrace'

const DRAG_COMMANDS = new Set(['update_marker', 'move_layer', 'move_layers',
  'move_layers_to_new_track', 'move_layers_to_composition', 'trim_layer'])

export function newEditTraceId(command: string): string | undefined {
  if (!DRAG_COMMANDS.has(command)) return undefined
  try {
    const setting = localStorage.getItem('weftcut.debug.editTrace')
    if (setting === '0' || (setting !== '1' && import.meta.env.VITE_WEFTCUT_EDIT_TRACE !== '1')) return undefined
    return `edit-${crypto.randomUUID()}`
  } catch { return undefined }
}

// Observe two seconds from the commit request, covering the 500ms autosave.
// rAF gaps are scheduling evidence, NOT a measurement of physical presentation.
// At most four concurrent windows; fast repeated edits cannot grow observers.
let observing = 0
export function observeEditFrames(id: string): void {
  if (observing >= 4 || typeof requestAnimationFrame !== 'function') return
  observing++
  const trace = new EditTrace(id, 'renderer.frames')
  let previous = performance.now(), maxGap = 0, maxGapOffset = 0, frames = 0, slowFrames = 0
  let longTasks = 0, longestTask = 0, totalTaskMs = 0
  let observer: PerformanceObserver | undefined
  let hidden = document.visibilityState !== 'visible'
  const consume = (entries: PerformanceEntry[]) => {
    for (const entry of entries) {
      if (entry.startTime + entry.duration <= trace.start) continue
      longTasks++; longestTask = Math.max(longestTask, entry.duration); totalTaskMs += entry.duration
    }
  }
  try {
    observer = new PerformanceObserver(list => consume(list.getEntries()))
    observer.observe({ type: 'longtask' })
  } catch { observer = undefined }
  const visibility = () => { hidden ||= document.visibilityState !== 'visible' }
  document.addEventListener('visibilitychange', visibility)
  const tick = (now: number) => {
    // A callback registered during a frame can receive that frame's timestamp,
    // which predates the edit. Never move the observation's start backwards.
    const gap = Math.max(0, now - previous)
    if (gap > maxGap) { maxGap = gap; maxGapOffset = previous - trace.start }
    frames++; if (gap > 50) slowFrames++
    previous = Math.max(previous, now); raf = requestAnimationFrame(tick)
  }
  let raf = requestAnimationFrame(tick)
  setTimeout(() => {
    cancelAnimationFrame(raf)
    if (observer) { consume(observer.takeRecords()); observer.disconnect() }
    document.removeEventListener('visibilitychange', visibility)
    trace.fact('hiddenDuringWindow', hidden)
    trace.fact('frames', frames); trace.fact('maxFrameGapMs', maxGap)
    trace.fact('maxFrameGapOffsetMs', maxGapOffset)
    trace.fact('trailingFrameGapMs', performance.now() - previous)
    trace.fact('framesOver50Ms', slowFrames); trace.fact('longTaskSupported', !!observer)
    trace.fact('longTasks', longTasks); trace.fact('longestTaskMs', longestTask)
    trace.fact('totalLongTaskMs', totalTaskMs)
    trace.report(); observing--
  }, 2000)
}

export function reportAfterFrameOpportunity(trace: EditTrace): void {
  if (typeof requestAnimationFrame !== 'function') { trace.report(); return }
  const end = trace.span('store_apply_to_two_raf')
  let first = 0, second = 0, finished = false
  const finish = (frameObserved: boolean) => {
    if (finished) return
    finished = true
    clearTimeout(timer); cancelAnimationFrame(first); cancelAnimationFrame(second)
    end(frameObserved); trace.fact('frameOpportunityObserved', frameObserved); trace.report()
  }
  const timer = setTimeout(() => finish(false), 2000)
  first = requestAnimationFrame(() => { second = requestAnimationFrame(() => finish(true)) })
}
