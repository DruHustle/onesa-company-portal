export interface BillingMountOptions {
  /** Current verified Portal session CSRF token. Never supply an access token. */
  csrf: () => string;
  onSessionExpired?: () => void;
  fetch?: typeof globalThis.fetch;
  navigate?: (verifiedHostedStripeUrl: string) => void;
}
export declare function mountBilling(element: HTMLElement, options: BillingMountOptions): Readonly<{ destroy(): void }>;
