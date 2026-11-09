import pg from 'pg';
import { loadConfig, type BillingConfig, type DatabaseRole } from './config.js';
import { BillingStore, verifyStorePoolRoles, type StorePools } from './store.js';
import { StripeCompanyProvider } from './stripe-provider.js';
import { BillingService } from './service.js';
import { verifyMigration } from './migrate.js';

export async function createRuntime(config: BillingConfig = loadConfig()) {
  const pools = Object.fromEntries((['api', 'dispatcher', 'webhook', 'meter'] as DatabaseRole[]).map(role => [role,
    new pg.Pool({ connectionString: config.secrets.database(role), max: 5, connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000, application_name: `onesa-billing-${role}`, allowExitOnIdle: true })])) as unknown as StorePools;
  const close = async () => { await Promise.all(Object.values(pools).map(pool => pool.end())); };
  // Unexpected idle connection errors cannot dump connection strings or SQL into logs.
  for (const pool of Object.values(pools)) pool.on('error', () => process.stderr.write('BILLING_DATABASE_CONNECTION_ERROR\n'));
  try {
    await verifyStorePoolRoles(pools);
    await Promise.all(Object.values(pools).map(pool => verifyMigration(pool)));
    const provider = new StripeCompanyProvider({ scope: config.scope, secretKey: config.secrets.stripe,
      webhookSecret: config.secrets.webhook, publicOrigin: config.returnBase,
      portalConfigurationId: config.portalConfigurationId, invoiceDaysUntilDue: config.invoiceDaysUntilDue,
      automaticTaxEnabled: config.taxEnabled, integrationIdentifier: config.integrationIdentifier,
      liveQualified: config.scope.mode === 'live' });
    await provider.verifyAccount();
    const store = new BillingStore({ scope: config.scope, pools });
    return { config, store, provider, service: new BillingService(config, store, provider), close };
  } catch (error) { await close(); throw error; }
}
