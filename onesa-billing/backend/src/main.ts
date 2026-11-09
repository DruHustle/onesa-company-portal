import { BillingError } from './domain.js';
import { createRuntime } from './runtime.js';
import { buildApp } from './app.js';

try {
  const runtime = await createRuntime();
  const app = buildApp(runtime.config, runtime.service);
  app.addHook('onClose', runtime.close);
  await app.listen({ host: runtime.config.host, port: runtime.config.port });
  process.stdout.write('ONESA_BILLING_API_READY\n');
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
  process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
} catch (error) {
  process.stderr.write(`${error instanceof BillingError ? error.code : 'BILLING_STARTUP_FAILED'}\n`);
  process.exitCode = 1;
}
