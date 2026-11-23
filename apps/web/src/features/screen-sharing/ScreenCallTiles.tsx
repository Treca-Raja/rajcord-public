import { Avatar } from '@tricord/ui';
import { Eye, Plus, MicOff, MonitorUp } from 'lucide-react';
import type { ScreenShare } from '@tricord/shared';
import type { VoiceState } from '../voice/contracts';
import { useEffect, useRef, useState } from 'react';

export function StreamTile({
  share,
  publisher,
  own,
  watching,
  focused,
  connecting,
  busy,
  watch,
  multiple,
  videoSource,
}: {
  share: Readonly<ScreenShare>;
  publisher: string;
  own: boolean;
  watching: boolean;
  focused: boolean;
  connecting: boolean;
  busy: boolean;
  watch: () => void;
  multiple: () => void;
  videoSource?: HTMLVideoElement | null;
}) {
  const thumbnail = useRef<HTMLVideoElement>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const stream = videoSource?.srcObject;
  const poster = videoSource?.poster;
  useEffect(() => {
    const element = thumbnail.current;
    if (!element) return;
    let current = true;
    setPreviewFailed(false);
    element.muted = true;
    element.srcObject = stream ?? null;
    if (stream) void element.play().catch(() => current && setPreviewFailed(true));
    return () => {
      current = false;
      element.pause();
      element.srcObject = null;
    };
  }, [stream]);
  return (
    <div
      className={'screen-stream-tile' + (watching || own ? ' is-selected' : '')}
      data-watching={watching}
      data-share-id={share.id}
    >
      {(stream || poster) && (
        <video
          ref={thumbnail}
          className="screen-stream-thumbnail"
          muted
          playsInline
          poster={poster}
          hidden={previewFailed}
          aria-label={`${publisher} stream preview`}
        />
      )}
      <span className="screen-stream-icon" aria-hidden="true">
        <MonitorUp size={26} />
      </span>
      <span className="screen-stream-state">LIVE</span>
      <span className="screen-stream-name">
        <strong>{own ? 'Your screen' : publisher}</strong>
        {previewFailed && <small>Preview unavailable</small>}
      </span>
      {!own && (
        <span className="screen-stream-actions">
          <button
            className="screen-stream-watch"
            disabled={busy}
            aria-pressed={focused}
            onClick={watch}
          >
            {connecting
              ? 'Connecting…'
              : focused
                ? 'Watching'
                : watching
                  ? 'Focus Stream'
                  : 'Watch Stream'}
          </button>
          <button
            className="screen-stream-multi"
            disabled={busy}
            aria-pressed={watching}
            aria-label={
              watching
                ? `Remove ${publisher} from multi-view`
                : `Watch ${publisher} with multiple streams`
            }
            title={watching ? 'Remove from multi-view' : 'Start watching multiple streams'}
            onClick={multiple}
          >
            <Eye size={18} aria-hidden="true" />
            <Plus size={10} className="screen-stream-add" aria-hidden="true" />
          </button>
        </span>
      )}
    </div>
  );
}

export function ParticipantTile({
  person,
  own,
  expanded,
  open,
}: {
  person: Readonly<VoiceState['participants'][number]>;
  own: boolean;
  expanded: boolean;
  open: (anchor: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      className="screen-participant-tile"
      data-speaking={person.speaking}
      disabled={own}
      aria-label={`${person.name}${person.muted ? ', muted' : ''}`}
      aria-haspopup={own ? undefined : 'dialog'}
      aria-expanded={own ? undefined : expanded}
      onClick={(event) => open(event.currentTarget)}
      onContextMenu={(event) => {
        if (!own) {
          event.preventDefault();
          open(event.currentTarget);
        }
      }}
    >
      <span className="screen-participant-avatar">
        <Avatar>{person.name.slice(0, 1).toUpperCase()}</Avatar>
        {person.muted && (
          <span className="screen-participant-muted" aria-label="Muted">
            <MicOff size={12} />
          </span>
        )}
      </span>
      <span className="screen-participant-name">
        <strong>{person.name}</strong>
        {own && <small>You</small>}
        <small className="screen-participant-status">
          {person.muted ? 'Muted' : person.speaking ? 'Speaking' : 'In voice'}
        </small>
      </span>
    </button>
  );
}
