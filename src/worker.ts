// Long-running background worker (one small container, or skip it and let
// a scheduler call POST /internal/cron every minute instead).
import { startJobLoop } from './domain/jobs.ts';
import { closeDb } from './db.ts';
import { log } from './lib/log.ts';

const stop = startJobLoop();
log.info('worker started');

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    log.info('worker stopping', { sig });
    stop();
    await closeDb();
    process.exit(0);
  });
}
