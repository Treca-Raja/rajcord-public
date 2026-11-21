import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { FeatureBoundary } from './FeatureBoundary';
import { CallContext, type Call } from './call';
import { AuthContext, type AuthContextValue } from '../features/account';
import { ScreenFeature } from '../app/ScreenFeature';
import { VoiceFeature } from '../app/VoiceFeature';
import { AuthRoot } from '../app/Auth';
import '../app/styles';

const fixture = {
  mode: 'settings',
  fault: false,
  leaves: 0,
  sourceStops: 0,
  watchStops: 0,
  cleanups: 0,
  render: () => {},
};
const screenState = {
  phase: 'idle',
  open: false,
  error: '',
  shares: [],
  watching: null,
  watchingShareIds: [],
  selectingShareId: null,
  layout: 'focus',
  playback: '',
  playbackTimeout: '',
  playbackMuted: false,
  playbackVolume: 1,
  hidden: false,
  label: '',
  viewers: 0,
  prepared: false,
  ownShareId: null,
  setupRequested: false,
};
const call = {
  get voice() {
    if (fixture.mode === 'voice' && fixture.fault)
      throw new Error('Synthetic voice render failure');
    return {
      status: 'idle',
      input: '',
      output: '',
      muted: true,
      deafened: false,
      outputVolume: 1,
      participants: [],
      devices: [],
      devicesStatus: 'ready',
    };
  },
  devices: [],
  controls: {
    leave: async () => {
      fixture.leaves++;
    },
    refreshDevices: async () => {},
  },
  get screens() {
    if (fixture.mode === 'voice') return undefined;
    return screens;
  },
} as unknown as Call;
const screens = {
  inspect: () => {
    if (fixture.fault) throw new Error('Synthetic screen render failure');
    return screenState;
  },
  subscribe: () => () => {
    fixture.cleanups++;
  },
  stopSource: () => {
    fixture.sourceStops++;
  },
  stopWatching: () => {
    fixture.watchStops++;
  },
};
const auth = {
  state: { user: { id: 'fixture', status: 'approved' } },
  request: async () => ({ channels: [] }),
} as unknown as AuthContextValue;
function Settings() {
  useEffect(
    () => () => {
      fixture.cleanups++;
    },
    [],
  );
  if (fixture.fault) throw new Error('Synthetic settings render failure');
  return <p>Settings fixture ready</p>;
}
function Fixture() {
  if (fixture.mode === 'auth')
    return (
      <AuthRoot>
        <p>Protected fixture content</p>
      </AuthRoot>
    );
  return (
    <AuthContext.Provider value={auth}>
      <CallContext.Provider value={call}>
        <label>
          Unaffected draft
          <input aria-label="Unaffected draft" defaultValue="Keep this draft" />
        </label>
        {fixture.mode === 'screen' ? (
          <ScreenFeature />
        ) : fixture.mode === 'voice' ? (
          <VoiceFeature />
        ) : (
          <FeatureBoundary name="Account settings">
            <Settings />
          </FeatureBoundary>
        )}
      </CallContext.Provider>
    </AuthContext.Provider>
  );
}
const root = createRoot(document.getElementById('root')!);
fixture.render = () => root.render(<Fixture />);
Object.assign(window, { featureFixture: fixture });
fixture.render();
