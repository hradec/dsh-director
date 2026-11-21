// DSH fork feature: replaces the Electron/napi bridge with DSH's HTTP editing
// routes. The renderer's backend calls all funnel through invoke/invokeRaw —
// this module IS the transport now. Commands hit the SAME EditingStore.command
// path the agent tools and UI share; tags re-derive server-side on every save.
// ponytail: project_open is a no-op because the tab pre-selects the editing id;
// subsystem commands (models, proxies, exports) pass through to the actor and
// surface its real "unknown op" error — no silent stubs.

type Cfg = { editingId: string; apiBase: string; session: string }

let cfg: Cfg | null = null
const cfg_ = (): Cfg => {
  if (!cfg) throw new Error('DSH timeline transport not configured')
  return cfg
}

export function configure(next: Cfg): void {
  cfg = next
}

const url = (path: string): string => {
  const base = cfg_().apiBase + path
  // The sidebar realm cannot send the studio session header from a plain fetch
  // context, so every API call also identifies itself in the query.
  return base + (base.includes('?') ? '&' : '?') + 'session=' + encodeURIComponent(cfg_().session)
}

const sessionHeaders = (): Headers => {
  const h = new Headers({ 'content-type': 'application/json' })
  h.set('X-Director-Session', cfg_().session)
  return h
}

async function getJson(path: string): Promise<any> {
  const r = await fetch(url(path), { headers: { 'X-Director-Session': cfg_().session } })
  if (!r.ok) throw new Error('DSH editing API ' + r.status + ': ' + (await r.text().catch(() => '')))
  return r.json()
}
async function postJson(path: string, body?: unknown): Promise<any> {
  const r = await fetch(url(path), { method: 'POST', headers: sessionHeaders(), body: JSON.stringify(body ?? {}) })
  if (!r.ok) throw new Error('DSH editing API ' + r.status + ': ' + (await r.text().catch(() => '')))
  return r.json()
}

export class CommandPublicationError extends Error {
  readonly accepted = true
  constructor(readonly command: string, cause: unknown) {
    super('Edit accepted, but the view could not synchronize. Refresh the view before continuing; do not repeat the edit.', { cause })
    this.name = 'CommandPublicationError'
  }
}

// Whole-projection reads: the server answers every publication with the full
// summary (no patch deltas yet); cached for the raw-read bypass path.
let publicationInFlight: Promise<any> | null = null
function publication(): Promise<any> {
  if (!publicationInFlight) {
    publicationInFlight = getJson(`/api/editing/${cfg_().editingId}/publication`)
      .finally(() => { publicationInFlight = null })
  }
  return publicationInFlight
}

// After any mutation the projection re-reads and applies straight into the
// store — the replacement for main's push events AND the publication-receipt
// protocol (single workspace owner, so no reconciliation is needed).
let refreshInFlight: Promise<unknown> | null = null
function refreshStore(): Promise<unknown> {
  if (!refreshInFlight) {
    // dynamic import: projectStore statically imports this module (cycle break)
    refreshInFlight = Promise.all([import('../state/projectStore'), publication()])
      .then(([m, p]) => m.useProjectStore.getState().apply(p.summary))
      .finally(() => { refreshInFlight = null })
  }
  return refreshInFlight
}

export function invokeRaw<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (cmd === 'project_publication') return publication() as Promise<T>
  if (cmd === 'project_summary') return publication().then((r) => r.summary) as Promise<T>
  return Promise.reject(new Error('DSH timeline: unknown read op ' + cmd))
}

export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const id = cfg_().editingId
  switch (cmd) {
    case 'project_publication': return await publication() as T
    case 'project_summary': return (await publication()).summary as T
    // The tab owns document selection; open/save/close are transport facts.
    case 'project_open': case 'project_new_workspace': case 'project_close': return null as T
    case 'project_save': case 'project_save_as': return undefined as T
    case 'project_undo': { const r = await postJson(`/api/editing/${id}/undo`); await refreshStore(); return r as T }
    case 'project_redo': { const r = await postJson(`/api/editing/${id}/redo`); await refreshStore(); return r as T }
    case 'project_create_checkpoint': return await postJson(`/api/editing/${id}/checkpoint`, { label: String(args?.label ?? 'checkpoint') }) as T
    default: {
      const r = await postJson(`/api/editing/${id}/command`, { channel: cmd, args: args ?? {} })
      if (r && r.ok === false) {
        const e = r.error ?? {}
        throw new Error('timeline op ' + cmd + ' rejected: ' + (e.code ?? 'error') + (e.detail ? ': ' + e.detail : ''))
      }
      await refreshStore()
      return r?.value as T
    }
  }
}

// Media bytes for <video>/WebCodecs: DSH serves workspace files with Range
// support over /api/file (the fork's resolver path).
export function convertFileSrc(filePath: string): string {
  return url('/api/file?path=' + encodeURIComponent(filePath) + (cfg_().session ? '&session=' + encodeURIComponent(cfg_().session) : ''))
}
