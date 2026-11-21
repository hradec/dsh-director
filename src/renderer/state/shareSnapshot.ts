/** Restore structural sharing lost at the JSON/IPC boundary. Only for plain
 * snapshot data (objects, arrays and scalars), never class instances or Maps.
 * Neither snapshot is mutated; every changed field remains authoritative. */
export function shareSnapshot<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous;
  if (previous === null || next === null || typeof previous !== 'object' || typeof next !== 'object') return next;
  if (Array.isArray(previous) !== Array.isArray(next)) return next;
  if (Array.isArray(previous) && Array.isArray(next)) {
    const shared = next.map((value, i) => shareSnapshot(previous[i], value));
    return (previous.length === next.length && shared.every((value, i) => value === previous[i]) ? previous : shared) as T;
  }
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  let equal = Object.keys(before).length === keys.length;
  const shared = { ...after };
  for (const key of keys) {
    shared[key] = shareSnapshot(before[key], after[key]);
    if (!Object.hasOwn(before, key) || shared[key] !== before[key]) equal = false;
  }
  return (equal ? previous : shared) as T;
}
