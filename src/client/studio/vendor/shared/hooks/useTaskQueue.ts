import { useRef, useState } from "react";

// FIFO background queue (same shape as the Footage tab's AI-tag queue): each request waits for
// the previous one, a toolbar chip shows what is running, and a failure surfaces without wedging the chain.

export interface QueuedTask {
  id: number;
  label: string;
}

export function useTaskQueue(run: (text: string) => Promise<void>) {
  const [tasks, setTasks] = useState<QueuedTask[]>([]);
  const [queueError, setQueueError] = useState<string | null>(null);
  const chain = useRef(Promise.resolve());
  const nextId = useRef(1);

  function enqueue(text: string, label: string) {
    const id = nextId.current++;
    setTasks((t) => [...t, { id, label }]);
    chain.current = chain.current
      .then(() => run(text))
      .catch((e) => setQueueError(String(e?.message || e)))
      .finally(() => setTasks((t) => t.filter((k) => k.id !== id)));
  }

  return { tasks, queueError, enqueue, clearQueueError: () => setQueueError(null) };
}
