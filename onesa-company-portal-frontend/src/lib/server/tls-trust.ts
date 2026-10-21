/** Block the compromised-chain CA from new application TLS connections.
 * GHSA-6q48-6c7w-9gw2; public certificate SHA-256, never a private key.
 * Run before clients are constructed. All other default/extra CAs are preserved.
 */
import tls from 'node:tls';
import {X509Certificate} from 'node:crypto';

export const blockedCAFingerprint = '86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b';
const ca = tls as typeof tls & {
  getCACertificates: (type: 'default') => string[];
  setDefaultCACertificates: (roots: readonly string[]) => void;
};
export function permittedCertificateRoots(roots: readonly string[]) {
  return roots.filter(root => new X509Certificate(root).fingerprint256.replaceAll(':', '').toLowerCase() !== blockedCAFingerprint);
}
export function activateTlsTrustPolicy() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must remain enabled');
  if (typeof ca.getCACertificates !== 'function' || typeof ca.setDefaultCACertificates !== 'function') throw new Error('TLS trust policy requires the supported Node 24 runtime');
  const before = ca.getCACertificates('default');
  const allowed = permittedCertificateRoots(before);
  if (allowed.length === 0) throw new Error('TLS trust policy cannot use an empty CA store');
  if (allowed.length !== before.length) ca.setDefaultCACertificates(allowed);
  const effective = ca.getCACertificates('default');
  if (effective.length === 0 || permittedCertificateRoots(effective).length !== effective.length) throw new Error('TLS trust policy did not remove the affected authority');
  return Object.freeze({policy: 'emsign-ecc-g3-20261020', blockedCAAbsent: true, removed: before.length - allowed.length, remaining: effective.length});
}
export const tlsTrustPolicy = activateTlsTrustPolicy();
