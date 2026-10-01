export interface SchedulerOptions {
  intervalMs: number;
  task: () => Promise<unknown>;
  onError: (err: unknown) => void;
}

/**
 * Fixed-delay loop: the next run is scheduled only after the previous one
 * settles, so runs never overlap within a process. Cross-process exclusion is
 * the store's ingest lock.
 */
export function startScheduler(opts: SchedulerOptions): { stop(): void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async () => {
    try {
      await opts.task();
    } catch (err) {
      opts.onError(err);
    }
    if (!stopped) timer = setTimeout(tick, opts.intervalMs);
  };
  timer = setTimeout(tick, 0);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
}
