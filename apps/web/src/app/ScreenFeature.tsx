import { useCallback } from 'react';
import { FeatureBoundary } from '../shared/FeatureBoundary';
import { useCall } from '../shared/call';
import { ScreenPanel } from '../features/screen-sharing';
import type { VoiceChannel } from '../features/voice/contracts';

export function ScreenFeature({ voiceChannels = [] }: { voiceChannels?: VoiceChannel[] }) {
  const screens = useCall()?.screens;
  const stop = useCallback(() => {
    if (!screens) return;
    try {
      screens.stopSource();
    } finally {
      screens.stopWatching();
    }
  }, [screens]);
  return (
    <FeatureBoundary name="Screen sharing" onFailure={stop}>
      <ScreenPanel voiceChannels={voiceChannels} />
    </FeatureBoundary>
  );
}
