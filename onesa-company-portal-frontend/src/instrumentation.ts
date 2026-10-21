// The Node-only trust policy completes before Next accepts requests.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./lib/server/tls-trust');
}
