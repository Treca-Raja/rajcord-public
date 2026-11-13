import { expect, it } from 'vitest';
import { PickerIpcBudget, trustedPickerCaller } from './picker-ipc-policy.js';

it('requires exact picker objects, URL, navigation generation and a live frame', () => {
  const expected = {
    webContents: {},
    mainFrame: {},
    url: 'file:///synthetic/picker.html',
    navigation: 1,
    alive: true,
  };
  expect(
    trustedPickerCaller(expected, { ...expected }, expected.webContents, expected.mainFrame),
  ).toBe(true);
  for (const change of [
    { webContents: {} },
    { mainFrame: {} },
    { url: expected.url + '#changed' },
    { navigation: 2 },
    { alive: false },
  ])
    expect(
      trustedPickerCaller(
        expected,
        { ...expected, ...change },
        expected.webContents,
        expected.mainFrame,
      ),
    ).toBe(false);
  expect(trustedPickerCaller(expected, expected, {}, expected.mainFrame)).toBe(false);
  expect(trustedPickerCaller(expected, expected, expected.webContents, {})).toBe(false);
  expect(trustedPickerCaller(expected, null, expected.webContents, null)).toBe(false);
});
it('caps pending picker work and request rate independently, including idempotent release', () => {
  let time = 0;
  const budget = new PickerIpcBudget(() => time),
    first = budget.acquire()!,
    second = budget.acquire()!;
  expect(budget.acquire()).toBeNull();
  first();
  first();
  for (let i = 0; i < 10; i++) budget.acquire()!();
  expect(budget.acquire()).toBeNull();
  second();
  time = 1000;
  expect(budget.acquire()).not.toBeNull();
});
