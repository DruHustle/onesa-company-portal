import 'server-only';
import {cache} from 'react';
import {publicServerApi} from './api/server';

// Share only within this render: neither operating mode nor approvals cross visitors.
const publicationStatus = cache(async () => {
  if (process.env.PUBLIC_RELEASE_ENABLED !== 'true') return null;
  const company = await publicServerApi().GET('/api/v1/public/company').catch(() => null);
  return company?.data ?? null;
});

// Public production publishing follows the owner-authorized operating mode.
// Actual legal readiness remains the API's separate release_ready value.
export const publicationReady = cache(async () => {
  const company = await publicationStatus();
  return company?.publication_enabled === true || company?.release_ready === true;
});

// The explicit pre-launch exception enables features without inventing legal approval.
// Check in each leaf too: Next can serialize children independently of their layout.
export const publicContentAllowed = cache(async () => {
  if (process.env.PUBLIC_RELEASE_ENABLED !== 'true') return true;
  const company = await publicationStatus();
  return company?.publication_enabled === true || company?.release_ready === true;
});
