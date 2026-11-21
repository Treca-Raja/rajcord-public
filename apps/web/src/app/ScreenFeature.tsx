import { useCallback, type ComponentProps } from 'react';
import { FeatureBoundary } from '../shared/FeatureBoundary';
import { useCall } from '../shared/call';
import { ScreenPanel } from '../features/screen-sharing';

export function ScreenFeature(props: ComponentProps<typeof ScreenPanel>) {
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
      <ScreenPanel {...props} />
    </FeatureBoundary>
  );
}
