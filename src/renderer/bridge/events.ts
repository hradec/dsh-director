// DSH fork: cross-window events replaced by an in-page emitter. Mutations
// refresh through the projection re-read in the transport, not push events.
export interface Event<T> { event: string; id: number; payload: T }
export type UnlistenFn = () => void

const handlers = new Map<string, Set<(e: Event<unknown>) => void>>()

export async function listen<T>(
  event: string,
  handler: (e: Event<T>) => void,
): Promise<UnlistenFn> {
  let set = handlers.get(event)
  if (!set) { set = new Set(); handlers.set(event, set) }
  const wrapped = handler as (e: Event<unknown>) => void
  set.add(wrapped)
  return () => { set!.delete(wrapped) }
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  for (const h of handlers.get(event) ?? []) h({ event, id: 0, payload })
}
