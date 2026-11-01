import { trustedNoticeFrame } from './notification-policy.js';

export async function createWindowOpenHandler(options: {
  target: string;
  currentUrl: () => string;
  openExternal: (url: string) => Promise<unknown>;
  onError: () => void;
}) {
  const { safeHttpUrl } = await import('@tricord/shared');
  return ({ url }: { url: string }): { action: 'deny' } => {
    const href = safeHttpUrl(url);
    if (href && trustedNoticeFrame(options.target, options.currentUrl(), true)) {
      void options.openExternal(href).catch(options.onError);
    }
    return { action: 'deny' };
  };
}
