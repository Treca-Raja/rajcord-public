import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  gifCandidates,
  GifPreviewError,
  GifPreviewSession,
  type GifFrame,
  type GifMetadata,
} from './gif-policy';
import './media.css';

function GifPreview({ url }: { url: string }) {
  const id = useId();
  const canvas = useRef<HTMLCanvasElement>(null);
  const session = useRef<GifPreviewSession | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const playing = useRef(false);
  const decoding = useRef(false);
  const version = useRef(0);
  const nextFrame = useRef(1);
  const frameDelay = useRef(100);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [isPlaying, setIsPlaying] = useState(false);
  const [metadata, setMetadata] = useState<GifMetadata | null>(null);
  const [explanation, setExplanation] = useState('');
  const hostname = new URL(url).hostname;

  const pause = useCallback(() => {
    playing.current = false;
    version.current++;
    clearTimeout(timer.current);
    setIsPlaying(false);
  }, []);

  const release = useCallback(() => {
    playing.current = false;
    version.current++;
    clearTimeout(timer.current);
    session.current?.dispose();
    session.current = null;
    if (canvas.current) {
      canvas.current.width = 0;
      canvas.current.height = 0;
    }
  }, []);

  useEffect(() => {
    const visibility = () => {
      if (document.visibilityState !== 'visible') pause();
    };
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const reducedMotion = () => {
      if (motion.matches) pause();
    };
    const observer =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            if (entries.some((entry) => !entry.isIntersecting)) pause();
          })
        : undefined;
    const element = canvas.current;
    if (element) observer?.observe(element);
    document.addEventListener('visibilitychange', visibility);
    motion.addEventListener('change', reducedMotion);
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      motion.removeEventListener('change', reducedMotion);
      release();
      if (element) {
        element.width = 0;
        element.height = 0;
      }
    };
  }, [pause, release]);

  function paint(frame: GifFrame) {
    const element = canvas.current;
    if (!element || typeof VideoFrame === 'undefined' || !(frame instanceof VideoFrame))
      throw new GifPreviewError('decode');
    const context = element.getContext('2d');
    if (!context) throw new GifPreviewError('unsupported');
    if (element.width !== frame.displayWidth) element.width = frame.displayWidth;
    if (element.height !== frame.displayHeight) element.height = frame.displayHeight;
    context.clearRect(0, 0, element.width, element.height);
    context.drawImage(frame, 0, 0);
  }

  function fail(error: unknown) {
    release();
    setIsPlaying(false);
    setMetadata(null);
    setPhase('error');
    setExplanation(
      error instanceof GifPreviewError ? error.message : new GifPreviewError('decode').message,
    );
  }

  async function load() {
    if (session.current || document.visibilityState !== 'visible') return;
    const current = new GifPreviewSession(url);
    session.current = current;
    setPhase('loading');
    setExplanation('');
    try {
      const loaded = await current.load(true, (frame) => {
        if (session.current === current) paint(frame);
      });
      if (session.current !== current) return;
      nextFrame.current = loaded.frames > 1 ? 1 : 0;
      frameDelay.current = loaded.delayMs;
      setMetadata(loaded);
      setPhase('loaded');
    } catch (error) {
      if (session.current === current) fail(error);
    }
  }

  function schedule() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void advance(), frameDelay.current);
  }

  async function advance() {
    const current = session.current;
    if (!current || !playing.current || !metadata || decoding.current) return;
    const revision = version.current;
    decoding.current = true;
    try {
      const delay = await current.frame(nextFrame.current, (frame) => {
        if (session.current === current && playing.current && revision === version.current)
          paint(frame);
      });
      if (session.current !== current) return;
      if (playing.current && revision === version.current) {
        frameDelay.current = delay;
        nextFrame.current = (nextFrame.current + 1) % metadata.frames;
      }
    } catch (error) {
      if (session.current === current) fail(error);
    } finally {
      decoding.current = false;
      if (session.current === current && playing.current) schedule();
    }
  }

  return (
    <section className="gif-preview" aria-label={'GIF preview from ' + hostname}>
      <p className="gif-privacy" id={id + '-privacy'}>
        Nothing loads automatically. Load GIF contacts {hostname} directly and shares your IP
        address and this GIF URL with that provider, without account cookies or a referrer. GIFs
        start paused, including with reduced motion enabled. Play is always your choice.
      </p>
      <a href={url} target="_blank" rel="noopener noreferrer" title={url}>
        Open GIF link on {hostname}
      </a>
      <canvas
        ref={canvas}
        className="gif-canvas"
        width={0}
        height={0}
        hidden={phase !== 'loaded'}
        role="img"
        aria-label={'User-shared GIF from ' + hostname + (isPlaying ? ', playing' : ', paused')}
      />
      <div className="gif-controls" aria-describedby={id + '-privacy'}>
        {(phase === 'idle' || phase === 'error') && (
          <button type="button" onClick={() => void load()} aria-describedby={id + '-privacy'}>
            Load GIF (paused)
          </button>
        )}
        {phase === 'loading' && <span role="status">Loading GIF…</span>}
        {phase === 'loaded' && metadata && (
          <button
            type="button"
            disabled={metadata.frames < 2}
            aria-pressed={isPlaying}
            onClick={() => {
              if (playing.current) pause();
              else if (document.visibilityState === 'visible') {
                playing.current = true;
                setIsPlaying(true);
                if (!decoding.current) schedule();
              }
            }}
          >
            {isPlaying ? 'Pause GIF' : 'Play GIF'}
          </button>
        )}
        {(phase === 'loading' || phase === 'loaded') && (
          <button
            type="button"
            onClick={() => {
              release();
              setIsPlaying(false);
              setMetadata(null);
              setPhase('idle');
              setExplanation('GIF unloaded. Loading again will contact the provider again.');
            }}
          >
            Stop / unload GIF
          </button>
        )}
      </div>
      {phase === 'loaded' && (
        <p className="gif-state" role="status">
          {metadata?.frames === 1
            ? 'Single-frame GIF; no animation.'
            : isPlaying
              ? 'Playing. Switching tabs or leaving the preview pauses playback.'
              : 'Paused. Press Play GIF to animate; leaving the page never resumes it automatically.'}
        </p>
      )}
      {explanation && (
        <p className="gif-state" role="status">
          {explanation}
        </p>
      )}
    </section>
  );
}

export function GifPreviews({ body }: { body: string }) {
  const candidates = useMemo(() => gifCandidates(body), [body]);
  return candidates.length ? (
    <div className="gif-previews">
      {candidates.map((url) => (
        <GifPreview key={url} url={url} />
      ))}
    </div>
  ) : null;
}
