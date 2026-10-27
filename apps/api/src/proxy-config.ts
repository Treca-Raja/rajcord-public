export function parseTrustProxyHops(value: string | undefined): 0 | 1 {
  if (value === undefined || value === '0') return 0;
  if (value === '1') return 1;
  throw new Error('TRUST_PROXY_HOPS must be 0 or 1.');
}
