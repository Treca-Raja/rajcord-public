import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { Notifications } from './Notifications';

const settings = vi.hoisted(() => ({ open: true }));
vi.mock('react-dom', () => ({ createPortal: (children: ReactNode) => children }));
vi.mock('./Auth', () => ({
  useAuth: () => ({
    state: { user: { id: 'account' } },
    socket: null,
    openSettings: vi.fn(),
    notificationSettingsHost: settings.open ? {} : null,
  }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  settings.open = true;
});
it('renders opt-in controls in the settings host without enabling popup or sound', () => {
  const getItem = vi.fn(() => null);
  vi.stubGlobal('localStorage', { getItem });
  const html = renderToStaticMarkup(
    createElement(Notifications, { selected: null, onOpen: vi.fn() }),
  );
  expect(html).toContain('aria-pressed="false">Enable notifications</button>');
  expect(html).toContain('aria-label="Notification popups"');
  expect(html).toContain('aria-label="Notification sound"');
  expect(html).not.toContain('checked=""');
});
it('preserves an existing popup opt-in but never enables sound as part of legacy migration', () => {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === 'tricord-notifications:account' ? 'on' : null),
  });
  const html = renderToStaticMarkup(
    createElement(Notifications, { selected: null, onOpen: vi.fn() }),
  );
  expect(html).toContain('aria-pressed="true">Disable notifications</button>');
  expect(html.match(/checked=""/g)).toHaveLength(1);
});
it('keeps notification controls out of the conversation when settings are closed', () => {
  settings.open = false;
  vi.stubGlobal('localStorage', { getItem: () => null });
  const html = renderToStaticMarkup(
    createElement(Notifications, { selected: null, onOpen: vi.fn() }),
  );
  expect(html).not.toContain('notification-settings');
  expect(html).not.toContain('Enable notifications');
  expect(html).not.toContain('Notification sound');
  expect(html).toContain('notification-toasts');
});
