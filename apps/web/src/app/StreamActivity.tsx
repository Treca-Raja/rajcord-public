import { useState, useSyncExternalStore, type RefObject } from 'react';
import { MonitorPlay, ArrowUpRight, Users } from 'lucide-react';
import { useCall } from '../shared/call';

const noSubscription = () => () => {};

function useStreamActivity() {
  const call = useCall();
  const screens = call?.screens;
  const connected = !!screens && call?.voice.status === 'connected';
  const liveCount = useSyncExternalStore(screens?.subscribe ?? noSubscription, () =>
    connected ? (screens.inspect().shares?.length ?? 0) : 0,
  );
  return { screens, connected, liveCount };
}

export function ActivityButton({
  trigger,
  expanded,
  onClick,
}: {
  trigger: RefObject<HTMLButtonElement | null>;
  expanded: boolean;
  onClick: () => void;
}) {
  const { connected, liveCount } = useStreamActivity();
  const live =
    liveCount > 0 ? liveCount + (liveCount === 1 ? ' live stream' : ' live streams') : '';
  return (
    <button
      ref={trigger}
      className={'header-action members-action' + (connected ? ' has-streams' : '')}
      title={live ? 'Activity: ' + live : 'Activity: members and streams'}
      aria-label={
        live ? live + ', Activity' : connected ? 'Streams and members, Activity' : 'Activity'
      }
      aria-description={connected ? undefined : 'Members'}
      aria-controls="workspace-activity"
      aria-expanded={expanded}
      onClick={onClick}
    >
      {connected ? (
        <>
          <MonitorPlay size={17} />
          <span>{live ? liveCount + ' live' : 'Streams'}</span>
        </>
      ) : (
        <Users size={18} />
      )}
    </button>
  );
}

export function StreamActivity({ onOpen }: { onOpen: () => void }) {
  const { screens, connected, liveCount } = useStreamActivity();
  const [error, setError] = useState('');
  if (!connected || !screens) return null;
  return (
    <section className="stream-activity" aria-label="Streams">
      <h2>
        <MonitorPlay size={16} aria-hidden="true" /> Streams
      </h2>
      <button
        onClick={() => {
          setError('');
          void screens.open().then(onOpen, (cause: unknown) => {
            setError(cause instanceof Error ? cause.message : 'Could not open the call.');
          });
        }}
      >
        <span>
          {liveCount
            ? liveCount + (liveCount === 1 ? ' live stream' : ' live streams')
            : 'Browse call'}
        </span>
        <ArrowUpRight size={16} aria-hidden="true" />
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
