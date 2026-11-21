import type { ProjectSummary } from '../../ipc';

/** Inputs shared by durable demand, live-key retention and preview warming.
 * All compositions matter for retention, including currently closed timelines.
 * Placement and Group clocks affect demand; visual transforms affect neither
 * captured content nor the used content interval. Keep that knowledge here. */
export function motifPlanningInputs(summary: ProjectSummary | null): unknown {
  if (!summary) return null;
  return [summary.project_id, summary.root_id, Object.entries(summary.compositions).map(([id, comp]) => [
    id, comp.tracks.filter(track => track.enabled).flatMap(track => track.layers.flatMap(layer => {
      if (!layer.enabled) return [];
      const p = layer.params;
      if (p.kind !== 'Motif' && p.kind !== 'CompositionRef') return [];
      return [[layer.id, layer.t_start_us, layer.t_end_us,
        p.kind, p.src_in_us, p.time_map, p.source_phase, p.content_window,
        p.kind === 'Motif' ? [p.motif_id, p.props] : [p.composition_id, p.src_out_us]]];
    })),
  ])];
}
