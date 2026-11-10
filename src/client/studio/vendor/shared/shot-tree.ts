/** Production hierarchy grouping: Season ▸ Episode ▸ Sequence ▸ Shot.
 *  ponytail: the timeline API gives shots only a sequence_id — the episode MUST be derived through
 *  the sequence. Matching on shot.episode_id (a field the API never sends) put every shot in
 *  Unassigned with empty season/sequence counts (0.2.20 bug). Kept as a pure function so the unit
 *  test in test/shot-tree.test.mjs can cover it without rendering the page. */

export interface TreeShot {
  id: string;
  sequence_id?: string | null;
  episode_id?: string | null;
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
      .map((q) => ({ sequence: q, shots: shots.filter((s) => s.sequence_id === q.id) }));
    const unsequenced = shots.filter((s) => (!s.sequence_id || !sequenceById.has(s.sequence_id)) && episodeOf(s) === episode.id);
    if (unsequenced.length) groups.push({ sequence: null, shots: unsequenced });
    if (!seasons.has(episode.season)) seasons.set(episode.season, []);
    seasons.get(episode.season)!.push({ episode, groups });
  }
  const loose = shots.filter((s) => {
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
  return shots.filter((shot) => [shot.title, shot.script_beat, shot.shot_type, shot.camera_motion, (shot.arcs ?? []).join(" ")]
    .some((field) => String(field ?? "").toLowerCase().includes(needle)));
}
