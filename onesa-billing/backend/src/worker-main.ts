import { setTimeout } from 'node:timers/promises';
import { BillingError, ensure } from './domain.js';
import { createRuntime } from './runtime.js';
import { createMetronomeTransport } from './metronome.js';
import { exportNextUsage } from './usage.js';

try {
  const runtime = await createRuntime();
  try {
  const { config, service, store } = runtime;
  let running = true;
  process.on('SIGINT', () => { running = false; }); process.on('SIGTERM', () => { running = false; });
  ensure(!config.secrets.metronome || config.metronomeProjectId, 'METRONOME_PROJECT_REQUIRED', 503);
  const transport = config.secrets.metronome && config.metronomeProjectId ? createMetronomeTransport({
    scope: config.scope, metronomeProjectId: config.metronomeProjectId,
    environment: config.scope.mode === 'test' ? 'sandbox' : 'production',
  }, config.secrets.metronome) : undefined;
  process.stdout.write(`ONESA_BILLING_WORKER_READY usage_export=${transport ? 'enabled' : 'not_configured'}\n`);
    while (running) {
      try {
        const command = await service.dispatchNext();
        const reconciled = await service.reconcileNext();
        if (transport) await exportNextUsage(store, transport);
        if (!command.processed && !reconciled) await setTimeout(1_000);
      } catch (error) {
        process.stderr.write(`${error instanceof BillingError ? error.code : 'BILLING_WORKER_CYCLE_FAILED'}\n`);
        await setTimeout(2_000);
      }
    }
  } finally { await runtime.close(); }
} catch (error) {
  process.stderr.write(`${error instanceof BillingError ? error.code : 'BILLING_WORKER_STARTUP_FAILED'}\n`);
  process.exitCode = 1;
}
