import { startRNNoise, supportsRNNoise } from './rnnoise';
import { type MicrophoneProcessing } from './voice-processing';

export type NoiseSuppressionEngine = 'rnnoise' | 'browser' | 'unavailable' | null;
export type MicrophoneCapture = {
  source: MediaStreamTrack;
  outgoing: MediaStreamTrack;
  engine: NoiseSuppressionEngine;
  stop: () => void;
};

export async function captureMicrophone(
  input: string,
  processing: MicrophoneProcessing,
  allowRNNoise: boolean,
  signal: AbortSignal,
  onRNNoiseFailure: (error: unknown) => void,
  onProcessorFailure: (error: Error) => void,
): Promise<MicrophoneCapture> {
  const open = async (noiseSuppression: boolean) => {
    signal.throwIfAborted();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { deviceId: { exact: input }, ...processing, noiseSuppression },
    });
    const source = stream.getAudioTracks()[0];
    if (!source || signal.aborted) {
      stream.getTracks().forEach((track) => track.stop());
      signal.throwIfAborted();
      throw new Error('The selected microphone returned no audio track.');
    }
    source.enabled = false;
    return { stream, source };
  };

  if (processing.noiseSuppression && allowRNNoise) {
    if (supportsRNNoise()) {
      const { stream, source } = await open(false);
      const abort = () => source.stop();
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (source.getSettings().noiseSuppression === true)
          throw new Error('The browser did not disable its own suppression.');
        const graph = await startRNNoise(stream, signal, onProcessorFailure);
        if (signal.aborted || source.readyState === 'ended') {
          graph.stop();
          throw new Error('The selected microphone stopped during RNNoise startup.');
        }
        return {
          source,
          outgoing: graph.track,
          engine: 'rnnoise',
          stop: () => {
            source.stop();
            graph.stop();
          },
        };
      } catch (error) {
        source.stop();
        signal.throwIfAborted();
        onRNNoiseFailure(error);
      } finally {
        signal.removeEventListener('abort', abort);
      }
    } else onRNNoiseFailure(new Error('AudioWorklet or WebAssembly is unavailable.'));
  }

  const { source } = await open(processing.noiseSuppression);
  const applied = source.getSettings().noiseSuppression;
  if (!processing.noiseSuppression && applied === true) {
    source.stop();
    throw new Error('The browser did not turn off noise suppression on the selected microphone.');
  }
  return {
    source,
    outgoing: source,
    engine: processing.noiseSuppression ? (applied ? 'browser' : 'unavailable') : null,
    stop: () => source.stop(),
  };
}
