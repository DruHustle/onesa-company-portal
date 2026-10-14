import 'server-only';
import {cache} from 'react';
import {publicServerApi} from './api/server';

// Share only within this render: approval must never be reused across visitors.
export const publicationReady = cache(async () => {
  if (process.env.PUBLIC_RELEASE_ENABLED !== 'true') return false;
  const company = await publicServerApi().GET('/api/v1/public/company').catch(() => null);
  return company?.data?.release_ready === true;
});
