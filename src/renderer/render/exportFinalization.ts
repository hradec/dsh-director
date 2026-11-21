/** A completed encode is immutable. Retrying only consumes these files; it
 * never consults the current project or starts an encoder again. */
export function createExportFinalization(deps: {
  mux: () => Promise<void>;
  cleanup: () => Promise<void>;
  onRunning: () => void;
  onFailure: (detail: string) => void;
  onComplete: () => void;
}) {
  let busy = false;
  let discarded = false;
  let cleaned = false;
  let settled: Promise<void> = Promise.resolve();
  const cleanup = async () => {
    if (cleaned) return;
    await deps.cleanup();
    cleaned = true;
  };
  return {
    async retry() {
      if (busy || discarded || cleaned) return;
      busy = true;
      let resolve!: () => void;
      settled = new Promise<void>(done => { resolve = done; });
      deps.onRunning();
      try {
        await deps.mux();
        await cleanup();
        if (!discarded) deps.onComplete();
      } catch (error) {
        if (!discarded) deps.onFailure(error instanceof Error ? error.message : String(error));
      } finally {
        busy = false;
        try { if (discarded) await cleanup(); } finally { resolve(); }
      }
    },
    async discard() {
      discarded = true;
      // A running ffmpeg still reads the files. Cleanup follows its settlement.
      await settled;
      await cleanup();
    },
  };
}
