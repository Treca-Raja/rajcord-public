import { expect, it } from 'vitest';
import { obsIce } from './obs-screen.js';

it('keeps native TURN credentials off libnice’s unencrypted turns transport', () => {
  expect(
    obsIce([
      { urls: ['stun:fixture.invalid:3478'] },
      {
        urls: [
          'turn:fixture.invalid:3478?transport=udp',
          'turns:fixture.invalid:5349?transport=tcp',
        ],
        username: 'temporaryUser',
        credential: 'temporaryPassword',
      },
    ]),
  ).toEqual({
    uris: [
      'stun://fixture.invalid:3478',
      'turn://temporaryUser:temporaryPassword@fixture.invalid:3478?transport=udp',
    ],
    secure: { host: 'fixture.invalid', port: 5349, credentials: 'temporaryUser:temporaryPassword' },
  });
});

it('escapes coturn REST credentials and refuses datagram TLS or invalid ports', () => {
  const username = '1234567890.' + 'a'.repeat(32);
  const credential = '/+' + 'b'.repeat(25) + '=';
  expect(
    obsIce([{ urls: ['turn:fixture.invalid:3479?transport=tcp'], username, credential }]).uris,
  ).toEqual([`turn://${username}:%2F%2B${'b'.repeat(25)}%3D@fixture.invalid:3479?transport=tcp`]);
  for (const url of ['turns:fixture.invalid:5350?transport=udp', 'turn:fixture.invalid:99999'])
    expect(() => obsIce([{ urls: [url], username, credential }])).toThrow();
});
