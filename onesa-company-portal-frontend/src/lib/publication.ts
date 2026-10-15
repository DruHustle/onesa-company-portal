import 'server-only';

// The owner-controlled hosting flag identifies the approved public deployment.
// Public navigation and indexing must not depend on a live approval-status read.
// CMS endpoints still enforce published-content visibility; administration,
// private files and write operations retain their independent backend controls.
export async function publicationReady() {
  return process.env.PUBLIC_RELEASE_ENABLED === 'true';
}
