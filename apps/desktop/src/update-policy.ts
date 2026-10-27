export function trustedUpdateConfig(value: unknown): value is { publisherName: string[] | string } {
  if (!value || typeof value !== 'object') return false;
  const config = value as Record<string, unknown>;
  const names = Array.isArray(config.publisherName) ? config.publisherName : [config.publisherName];
  return (
    config.provider === 'github' &&
    config.owner === 'Treca-Raja' &&
    config.repo === 'tricord-public' &&
    config.verifyUpdateCodeSignature !== false &&
    names.length > 0 &&
    names.every((dn) => typeof dn === 'string' && dn.startsWith('CN='))
  );
}
