import catalog from './onesa-applications.json';

const internalDocuments = catalog.applications.find(app => app.id === 'engineering')!;
export const internalDocumentsOrigin = process.env.NEXT_PUBLIC_INTERNAL_DOCUMENTS_CANONICAL === 'true'
  ? internalDocuments.canonicalHref!
  : null;
