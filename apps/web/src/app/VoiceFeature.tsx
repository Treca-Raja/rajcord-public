import { useCallback, type ComponentProps } from 'react';
import { FeatureBoundary } from '../shared/FeatureBoundary';
import { runInBackground } from '../shared/background';
import { useCall } from '../shared/call';
import { VoicePanel } from '../features/voice';

export function VoiceFeature(props: ComponentProps<typeof VoicePanel>) {
  const controls = useCall()?.controls;
  const leave = useCallback(() => {
    if (controls) runInBackground(controls.leave());
  }, [controls]);
  return (
    <FeatureBoundary name="Voice chat" onFailure={leave}>
      <VoicePanel {...props} />
    </FeatureBoundary>
  );
}
