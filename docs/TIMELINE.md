# Timeline, sequences, arcs & clip takes (0.2.14+)

## Hierarchy (Season → Episode → Sequence → Shot)
- **Season / Episode** live on the **Story wall** (Story tab → episodes): `director_studio story.episode` or the wall UI.
- **Sequence** = shot grouping inside one episode. New **Timeline tab** sidebar: pick an episode, press **+ Sequence**, assign shots with the per-shot Sequence dropdown (or `director_studio shot.update` with `sequence_id`).
- **Arcs are TAGS, not a level**: `arcs:["arc1","B-plot"]` on any shot — arc1/2/3 and sub-arcs can spread across episodes freely. Shown on timeline blocks.

## Timeline tab
- Sequence buttons switch the timeline; block width = shot duration (drag-free; edit Duration in the shot panel).
- **▶ Play** watches the whole cut shot-by-shot (sequential playback — no ffmpeg glue). Double-click a block to play from there.
- Clip per shot = its **selected take**; switch takes with the radio list — selection re-binds the shot immediately.

## Clip takes (every clip version keeps its guidance)
- Binding a clip to a shot **auto-registers a take**: snapshot of prompt sections + Picture refs + voice refs + job id — the original guidance for upscaling.
- Upscale takes: `take.create` with `kind:"upscale"`, `parent_take_id` (must be same shot), and `workflow_path` recorded.
- `take.select` (radio or tool) = the edit decision; the shot's current clip and the timeline follow it. `take.list` per shot.

## Dwarf Fortress companion (separate plugin, upstream /LIZARD/dev/dsh-director-dwarf-fortress)
- **Legends tab**: embeds LegendsViewer (works from other devices too — URL host is adapted).
- **World Map tab**: live world map from LegendsViewer; *Pin a site* → click the map → bind pins to studio scenes from the dropdown. Pins live in `.director-studio/world-map.json`.
