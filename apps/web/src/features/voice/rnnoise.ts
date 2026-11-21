import binaryUrl from './rnnoise.wasm?url';
import workletUrl from './rnnoise-worklet.ts?worker&url';
import { runInBackground } from '../../shared/background';

const startupTimeout = 5000;
let compiled: Promise<WebAssembly.Module> | undefined;

function loadModule() {
  compiled ??= (async () => {
    const response = await fetch(binaryUrl, { signal: AbortSignal.timeout(startupTimeout) });
    if (!response.ok) throw new Error('Could not load the RNNoise WASM asset.');
    if (response.headers.get('content-type')?.split(';')[0] === 'application/wasm')
      return WebAssembly.compileStreaming(response);
    return WebAssembly.compile(await response.arrayBuffer());
  })().catch((error: unknown) => {
    compiled = undefined;
    throw error;
  });
  return compiled;
}

export function supportsRNNoise() {
  return (
    typeof AudioContext === 'function' &&
    typeof AudioWorkletNode === 'function' &&
    typeof WebAssembly === 'object'
  );
}

export async function startRNNoise(
  stream: MediaStream,
  signal: AbortSignal,
  onFailure: (error: Error) => void,
) {
  signal.throwIfAborted();
  const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let output: MediaStreamTrack | undefined;
  let closed = false;
  let running = false;
  let stalled: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (closed) return;
    closed = true;
    clearTimeout(stalled);
    context.removeEventListener('statechange', stateChanged);
    output?.stop();
    source?.disconnect();
    node?.disconnect();
    if (node) {
      node.removeEventListener('processorerror', processorFailed);
      node.port.close();
    }
    if (context.state !== 'closed') runInBackground(context.close());
  };
  const fail = (error: Error) => {
    if (closed) return;
    if (running) onFailure(error);
    else failed(error);
  };
  const processorFailed = () => fail(new Error('RNNoise audio processor stopped.'));
  const stateChanged = () => {
    clearTimeout(stalled);
    if (context.state === 'closed') fail(new Error('RNNoise audio context closed.'));
    else if (context.state !== 'running')
      stalled = setTimeout(
        () => fail(new Error('RNNoise audio stopped rendering.')),
        startupTimeout,
      );
  };
  let failed!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => {
    failed = reject;
  });
  const aborted = () => failed(new DOMException('Microphone capture was canceled.', 'AbortError'));
  signal.addEventListener('abort', aborted, { once: true });
  const timeout = setTimeout(
    () => failed(new Error('RNNoise audio startup timed out.')),
    startupTimeout,
  );
  try {
    const initialized = (async () => {
      if (context.sampleRate !== 48000 || !context.audioWorklet)
        throw new Error('48 kHz AudioWorklet processing is unavailable.');
      const [module] = await Promise.all([
        loadModule(),
        context.audioWorklet.addModule(workletUrl),
      ]);
      signal.throwIfAborted();
      if (closed) throw new Error('RNNoise audio startup ended.');
      source = context.createMediaStreamSource(stream);
      node = new AudioWorkletNode(context, 'rajcord-rnnoise', {
        channelCount: 1,
        channelCountMode: 'explicit',
        outputChannelCount: [1],
        processorOptions: { module },
      });
      node.addEventListener('processorerror', processorFailed);
      const ready = new Promise<void>((resolve) => {
        node!.port.onmessage = (event: MessageEvent<unknown>) => {
          if (event.data === 'ready') resolve();
        };
      });
      const destination = context.createMediaStreamDestination();
      destination.channelCount = 1;
      output = destination.stream.getAudioTracks()[0]!;
      source.connect(node).connect(destination);
      await Promise.all([ready, context.resume()]);
      node.port.onmessage = null;
      return output;
    })();
    const track = await Promise.race([initialized, failure]);
    if (context.state !== 'running') throw new Error('RNNoise audio context did not start.');
    running = true;
    context.addEventListener('statechange', stateChanged);
    return { track, stop };
  } catch (error) {
    stop();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', aborted);
  }
}
