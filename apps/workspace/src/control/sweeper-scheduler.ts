import { SWEEP_INTERVAL_MS } from '@/control/constants';
import { sweepStaleCalls } from '@/data/calls';

declare global {
  var duplexdCallSweepTimer: NodeJS.Timeout | undefined;
}

export async function runCallSweep(): Promise<void> {
  try {
    const result = await sweepStaleCalls();

    if (result.incomplete > 0 || result.failed > 0) {
      console.info(
        `[calls] sweep incomplete=${result.incomplete} failed=${result.failed}`,
      );
    }
  } catch {
    // Do not log the caught database error: even with the inherited redaction
    // wrapper, the sweeper has no useful customer-facing recovery to add here.
    console.error('[calls] sweep failed');
  }
}

/**
 * Arms a delayed interval. It deliberately does not call `runCallSweep()`.
 * Starting or restarting the workspace therefore changes no call state; the
 * first possible sweep is one full interval later and still keys only off the
 * persisted heartbeat timestamps.
 */
export function startCallSweeper(): void {
  if (globalThis.duplexdCallSweepTimer !== undefined) {
    return;
  }

  globalThis.duplexdCallSweepTimer = setInterval(() => {
    void runCallSweep();
  }, SWEEP_INTERVAL_MS);
  globalThis.duplexdCallSweepTimer.unref();
}
