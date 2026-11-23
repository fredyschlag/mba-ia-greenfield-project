import type { Logger } from '@nestjs/common';
import { CONSUMER_ERROR_DELAY_MS } from './video-worker.constants';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Polls until aborted. A failed poll is logged and never ends the process. */
export async function runPollingLoop(
  pollOnce: () => Promise<unknown>,
  signal: AbortSignal,
  logger: Logger,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await pollOnce();
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      logger.error(`Queue polling failed: ${errorMessage(error)}`);
      await waitUnlessAborted(CONSUMER_ERROR_DELAY_MS, signal);
    }
  }
}
