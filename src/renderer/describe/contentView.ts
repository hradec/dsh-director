import type { DescSegment, RunSummary } from '../ipc';
import { segmentsForSpan } from './segmentsForSpan';

/** One published read: segments and summaries always come from the same view. */
export interface DescriptionContent {
  readonly segments: readonly DescSegment[];
  readonly summaries: readonly RunSummary[];
}

/** Presentation query; the cache's exact-window summary contract is unchanged. */
export function contentForWindow(content: DescriptionContent | null | undefined, startUs: number, endUs: number): { summary: string | null; segments: readonly DescSegment[] } {
  return {
    summary: summaryForWindow(content?.summaries ?? [], startUs, endUs),
    segments: segmentsForSpan(content?.segments ?? null, startUs, endUs),
  };
}

/// How far a run's window edge may fall inside the clip's source range and
/// still speak for it. `describe_clip` resolves its window from the layer's
/// TIMELINE span, which is frame-snapped, so its edges can sit a fraction of a
/// frame inside `[src_in_us, src_out_us]` (a 150.0165 s source on a 30 fps
/// timeline describes [0, 150.0 s]). A quarter second is several frames at any
/// rate and far less than any summary is about.
const SUMMARY_EDGE_SLACK_US = 250_000;

/// The summary a clip's content section leads with: of the runs whose window
/// covers the clip's `[srcInUs, srcOutUs]` up to the edge slack, the tightest —
/// the run over the clip itself before a wider clip of the same source, the
/// newest on a tie — else none: a narrower run's summary does not speak for the
/// whole clip.
function summaryForWindow(
  summaries: readonly RunSummary[],
  srcInUs: number,
  srcOutUs: number,
): string | null {
  let best: RunSummary | null = null;
  for (const s of summaries) {
    const covers =
      s.window[0] <= srcInUs + SUMMARY_EDGE_SLACK_US &&
      s.window[1] >= srcOutUs - SUMMARY_EDGE_SLACK_US;
    if (covers && (best === null || s.window[1] - s.window[0] < best.window[1] - best.window[0])) best = s;
  }
  return best?.text ?? null;
}

