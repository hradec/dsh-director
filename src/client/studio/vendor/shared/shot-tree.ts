/** Production hierarchy grouping: Season ▸ Episode ▸ Sequence ▸ Shot.
 *  ponytail: the timeline API gives shots only a sequence_id — the episode MUST be derived through
 *  the sequence. Matching on shot.episode_id (a field the API never sends) put every shot in
 *  Unassigned with empty season/sequence counts (0.2.20 bug). Kept as a pure function so the unit
 *  test in test/shot-tree.test.mjs can cover it without rendering the page. */

export interface TreeShot {
  id: string;
  sequence_id?: string | null;
  episode_id?: string | null;
  order?: number | null;
  created_at?: string;
}

export interface TreeEpisode {
  id: string;
  title: string;
  season: number;
  order: number;
}

export interface TreeSequence {
  id: string;
  name: string;
  episode_id: string;
  order: number;
}

export interface ShotGroup<T extends TreeShot> {
  sequence: TreeSequence | null;
  shots: T[];
}

export interface EpisodeNode<T extends TreeShot> {
  episode: TreeEpisode;
  groups: ShotGroup<T>[];
}

export function buildShotTree<T extends TreeShot>(shots: T[], episodes: TreeEpisode[], sequences: TreeSequence[]) {
  // ponytail: sort defensively by explicit order so a drag re-order renders even from unsorted local state.
  const ordered = [...shots].sort((a, b) => ((a.order ?? 0) - (b.order ?? 0)) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  const sequenceById = new Map(sequences.map((q) => [q.id, q] as const));
  const episodeOf = (shot: T): string => {
    if (shot.sequence_id) {
      const q = sequenceById.get(shot.sequence_id);
      if (q) return q.episode_id;
    }
    return shot.episode_id ?? "";
  };
  const episodeIds = new Set(episodes.map((e) => e.id));
  const seasons = new Map<number, EpisodeNode<T>[]>();
  for (const episode of [...episodes].sort((a, b) => a.season - b.season || a.order - b.order)) {
    const groups: ShotGroup<T>[] = [...sequences]
      .filter((q) => q.episode_id === episode.id)
      .sort((a, b) => a.order - b.order)
      .map((q) => ({ sequence: q, shots: ordered.filter((s) => s.sequence_id === q.id) }));
    const unsequenced = ordered.filter((s) => (!s.sequence_id || !sequenceById.has(s.sequence_id)) && episodeOf(s) === episode.id);
    if (unsequenced.length) groups.push({ sequence: null, shots: unsequenced });
    if (!seasons.has(episode.season)) seasons.set(episode.season, []);
    seasons.get(episode.season)!.push({ episode, groups });
  }
  const loose = ordered.filter((s) => {
    const ep = episodeOf(s);
    return !ep || !episodeIds.has(ep);
  });
  return { seasons: [...seasons.entries()], loose };
}

export interface FilterableShot extends TreeShot {
  title?: string;
  script_beat?: string;
  shot_type?: string;
  camera_motion?: string;
  arcs?: string[];
}

/** ponytail: single free-text match over the fields the tree shows — one box, no facet UI. */
export function filterShots<T extends FilterableShot>(shots: T[], text: string): T[] {
  const needle = text.trim().toLowerCase();
  if (!needle) return shots;
  return shots.filter((shot) => matchShotFields(shot, needle));
}

export function matchShotFields<T extends FilterableShot>(shot: T, needle: string): boolean {
  return [shot.title, shot.script_beat, shot.shot_type, shot.camera_motion, (shot.arcs ?? []).join(" ")]
    .some((field) => String(field ?? "").toLowerCase().includes(needle));
}

export interface ShotTree<T extends FilterableShot> {
  seasons: [number, EpisodeNode<T>[]][];
  loose: T[];
}

const labelMatches = (label: string, segment: string) => !segment || label.toLowerCase().includes(segment);
const episodeLabel = (e: TreeEpisode) => `${e.title ?? ""} E${e.order}`;

/** Path-aware pruning (user grammar):
 *  - plain word ("Cold", "Season 1", "arc1"): matches a season/episode/sequence NAME (whole subtree
 *    shown) or shot fields (only matching shots kept).
 *  - slash query ("Season 1/E1", "Season 1//cold", "Season 1//cold/splash"): segments align to
 *    Season/Episode/Sequence/Shot levels; an empty segment skips (wildcards) that level. */
export function pruneShotTree<T extends FilterableShot>(tree: ShotTree<T>, query: string): ShotTree<T> {
  const q = query.trim();
  if (!q) return tree;
  if (!q.includes("/")) {
    const w = q.toLowerCase();
    const seasons: [number, EpisodeNode<T>[]][] = [];
    for (const [season, nodes] of tree.seasons) {
      if (labelMatches(`Season ${season}`, w)) {
        seasons.push([season, nodes]);
        continue;
      }
      const kept: EpisodeNode<T>[] = [];
      for (const node of nodes) {
        if (labelMatches(episodeLabel(node.episode), w)) {
          kept.push(node);
          continue;
        }
        const groups = node.groups
          .map((g) => (labelMatches(g.sequence?.name ?? "", w) ? g : { ...g, shots: g.shots.filter((s) => matchShotFields(s, w)) }))
          .filter((g) => g.shots.length || labelMatches(g.sequence?.name ?? "", w));
        if (groups.length) kept.push({ ...node, groups });
      }
      if (kept.length) seasons.push([season, kept]);
    }
    return { seasons, loose: tree.loose.filter((s) => matchShotFields(s, w)) };
  }
  const [seasonSeg = "", epSeg = "", seqSeg = "", ...shotRest] = q.split("/").map((part) => part.trim().toLowerCase());
  const shotSeg = shotRest.join(" ").trim();
  const seasons: [number, EpisodeNode<T>[]][] = [];
  for (const [season, nodes] of tree.seasons) {
    if (!labelMatches(`Season ${season}`, seasonSeg)) continue;
    const kept: EpisodeNode<T>[] = [];
    for (const node of nodes) {
      if (!labelMatches(episodeLabel(node.episode), epSeg)) continue;
      let groups = node.groups.filter((g) => labelMatches(g.sequence?.name ?? "", seqSeg));
      if (shotSeg) groups = groups.map((g) => ({ ...g, shots: g.shots.filter((s) => matchShotFields(s, shotSeg)) })).filter((g) => g.shots.length);
      if (groups.length) kept.push({ ...node, groups });
    }
    if (kept.length) seasons.push([season, kept]);
  }
  return { seasons, loose: [] }; // ponytail: homeless shots have no path to align segments against; a slash query hides them.
}
