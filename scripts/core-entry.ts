export { createActor, SCHEMA_VERSION } from '../src/main/state/actor'
export { initEval } from '../src/renderer/eval/index'
// The renderer consumes a ProjectSummary projection, not the raw document:
// main's own builder rides the core bundle so the server answers every
// publication with exactly what WeftCut desktop shows.
export { buildProjectSummary } from '../src/main/state/summary'
