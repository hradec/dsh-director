// Filesystem-first asset references: one shared implementation of the library
// source/refs/patch calls every asset page (actors, scenes, props) uses.
import { parseError } from "./client";

export interface RefMetaEntry {
  tags?: string[];
  note?: string;
}

/** Shape common to every asset record the library endpoints return. */
export interface ReferenceAsset {
  id: string;
  name: string;
  description?: string;
  notes?: string;
  folder?: string | null;
  sources?: string[];
  files?: Record<string, string | null>;
  urls?: Record<string, string>;
  ref_meta?: Record<string, RefMetaEntry>;
}

export interface RefUpdateResult {
  key: string;
  tags: string[];
  note: string;
}

export interface SourceScanResult {
  added: number;
  asset: ReferenceAsset;
}

// Legacy files may have no ref_meta entry — the server treats them as brainstorming.
export function refTagsOf(asset: Pick<ReferenceAsset, "ref_meta">, key: string): string[] {
  const tags = asset.ref_meta?.[key]?.tags;
  return Array.isArray(tags) ? tags : ["brainstorming"];
}

export function refNoteOf(asset: Pick<ReferenceAsset, "ref_meta">, key: string): string {
  return asset.ref_meta?.[key]?.note ?? "";
}

const libPath = (kind: string, id: string, suffix = "") =>
  `/api/library/${encodeURIComponent(kind)}/${encodeURIComponent(id)}${suffix}`;

const jsonInit = (method: string, body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// PATCH /api/library/{kind}/{id} — name, notes and the story description.
export async function patchAsset<T extends ReferenceAsset = ReferenceAsset>(
  kind: string,
  assetId: string,
  body: { name?: string; notes?: string; description?: string },
): Promise<T> {
  const res = await fetch(libPath(kind, assetId), jsonInit("PATCH", body));
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// PUT refs — free tags plus the two server-enforced exclusive trust tags (approved ↔ brainstorming).
export async function setAssetRef(
  kind: string,
  assetId: string,
  key: string,
  body: { tags_add?: string[]; tags_remove?: string[]; note?: string },
): Promise<RefUpdateResult> {
  const res = await fetch(libPath(kind, assetId, `/refs/${encodeURIComponent(key)}`), jsonInit("PUT", body));
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// Attach a workspace folder; its new media is copied into the asset as brainstorming references.
export async function attachAssetSource(kind: string, assetId: string, path: string): Promise<SourceScanResult> {
  const res = await fetch(libPath(kind, assetId, "/source"), jsonInit("POST", { path }));
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// Re-scan every already-attached folder for media that appeared since the last scan.
export async function scanAssetSources(kind: string, assetId: string): Promise<SourceScanResult> {
  const res = await fetch(libPath(kind, assetId, "/scan"), jsonInit("POST", {}));
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// Generalized version of the old actors-only deleteActorFile helper.
export async function deleteAssetFile(kind: string, assetId: string, key: string): Promise<void> {
  const res = await fetch(libPath(kind, assetId, `/files/${encodeURIComponent(key)}`), { method: "DELETE" });
  if (!res.ok) throw new Error(await parseError(res));
}
