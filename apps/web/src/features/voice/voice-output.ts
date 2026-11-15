// Keep the gain graph off the hardware destination: only the routed audio element plays it.
export class VoiceOutput {
  private context?: AudioContext;
  private graphs = new Map<
    HTMLAudioElement,
    {
      source: MediaStreamAudioSourceNode;
      feeder: HTMLAudioElement;
      gain: GainNode;
      destination: MediaStreamAudioDestinationNode;
    }
  >();
  private volume = 1;

  setVolume(value: number) {
    this.volume = value;
    for (const graph of this.graphs.values()) graph.gain.gain.value = value;
  }

  needsPreparation(element: HTMLAudioElement) {
    return this.volume > 1 && !this.graphs.has(element);
  }

  get needsEnable() {
    return (!this.context && this.volume > 1) || (this.context && !this.isRunning(this.context));
  }

  private isRunning(context: AudioContext) {
    return context.state === 'running';
  }

  async enable() {
    if (!this.context && this.volume > 1) {
      if (typeof AudioContext === 'undefined')
        throw new Error('Voice amplification is unavailable in this browser.');
      this.context = new AudioContext();
    }
    const context = this.context;
    if (context && !this.isRunning(context)) {
      await context.resume();
      if (context === this.context && !this.isRunning(context))
        throw new Error('Enable audio playback to allow voice amplification.');
    }
  }

  volumeFor(element: HTMLAudioElement) {
    return this.graphs.has(element) ? 1 : Math.min(this.volume, 1);
  }

  async prepare(element: HTMLAudioElement, output: string) {
    const context = this.context;
    if (!context) return;
    if (!this.graphs.has(element)) {
      // Chromium needs a playing source element to keep remote WebRTC audio flowing.
      // It stays silent; the processed stream is the only audible output.
      const feeder = document.createElement('audio');
      feeder.muted = true;
      feeder.volume = 0;
      feeder.srcObject = element.srcObject;
      const source = context.createMediaStreamSource(element.srcObject as MediaStream);
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      gain.gain.value = this.volume;
      try {
        source.connect(gain);
        gain.connect(destination);
        element.srcObject = destination.stream;
        this.graphs.set(element, { source, gain, destination, feeder });
      } catch (error) {
        feeder.pause();
        feeder.srcObject = null;
        source.disconnect();
        gain.disconnect();
        destination.stream.getTracks().forEach((track) => track.stop());
        throw error;
      }
    }
    const graph = this.graphs.get(element)!;
    await graph.feeder.setSinkId(output);
    if (this.graphs.get(element) !== graph) return;
    await graph.feeder.play();
  }

  release(element: HTMLAudioElement) {
    const graph = this.graphs.get(element);
    if (!graph) return;
    graph.feeder.pause();
    graph.feeder.srcObject = null;
    graph.source.disconnect();
    graph.gain.disconnect();
    graph.destination.stream.getTracks().forEach((track) => track.stop());
    this.graphs.delete(element);
  }

  async close() {
    for (const element of this.graphs.keys()) this.release(element);
    const context = this.context;
    this.context = undefined;
    if (context && context.state !== 'closed') await context.close();
  }
}
