// Numerical v3 animation semantics, injected into the frozen wire migration.
// Regression tests compare pre/post-migration geometry at every sampled frame.
// Any future change to interpolation semantics must keep this adapter compatible
// with v3 or provide a versioned evaluator; never substitute current defaults.
import { resolveAnimated } from '../../renderer/render/animated'
import { evaluatePositions } from '../../renderer/render/position'
import type { Animated } from '../../shared/keyframe'
import type { PositionAnimation } from '../../shared/position'
import type { MigrationContext } from './migrate'

function scalar(track: unknown, times: readonly number[], fallback: number): number[] {
  const value = track as Animated<number> | undefined
  // Never bake a silently truncated legacy track. 4096 is the v3 evaluator
  // capacity, frozen independently of future runtime capacity increases.
  if (value?.mode === 'Keyframed' && value.value.length > 4096) throw new Error('Schema v3 → v4: legacy curve exceeds evaluator capacity')
  return times.map(at => resolveAnimated(value, at, fallback))
}

export const migrationEvaluation: Pick<MigrationContext, 'sampleScalar' | 'samplePosition'> = {
  sampleScalar: scalar,
  samplePosition: (position, times) => {
    const p = position as PositionAnimation
    if (p.mode === 'XY') {
      const xs = scalar(p.x, times, 0), ys = scalar(p.y, times, 0)
      return times.map((_, i) => ({ x: xs[i], y: ys[i] }))
    }
    if (p.progress.mode === 'Keyframed' && p.progress.value.length > 4096) throw new Error('Schema v3 → v4: legacy path progress exceeds evaluator capacity')
    return evaluatePositions(p, times)
  },
}
