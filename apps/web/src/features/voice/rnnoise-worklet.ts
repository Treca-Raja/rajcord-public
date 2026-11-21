export {};

const frameSize = 480;
const pcmScale = 32768;

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
type ProcessorOptions = { processorOptions: { module: WebAssembly.Module } };
declare function registerProcessor(
  name: string,
  processor: new (options: ProcessorOptions) => AudioWorkletProcessor,
): void;

type RNNoiseExports = {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(size: number): number;
  rnnoise_create(model: number): number;
  rnnoise_get_frame_size(): number;
  rnnoise_process_frame(state: number, output: number, input: number): number;
};

class RNNoiseProcessor extends AudioWorkletProcessor {
  private readonly wasm: RNNoiseExports;
  private readonly state: number;
  private readonly pointer: number;
  private readonly frame: Float32Array;
  private offset = 0;
  private started = false;

  constructor({ processorOptions }: ProcessorOptions) {
    super();
    this.wasm = new WebAssembly.Instance(processorOptions.module).exports as RNNoiseExports;
    this.wasm._initialize();
    if (sampleRate !== 48000 || this.wasm.rnnoise_get_frame_size() !== frameSize)
      throw new Error('RNNoise requires 48 kHz audio and 480-sample frames.');
    this.state = this.wasm.rnnoise_create(0);
    this.pointer = this.wasm.malloc(frameSize * Float32Array.BYTES_PER_ELEMENT);
    if (!this.state || !this.pointer) throw new Error('RNNoise could not allocate its state.');
    this.frame = new Float32Array(this.wasm.memory.buffer, this.pointer, frameSize);
    this.frame.fill(0);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    const input = inputs[0]?.[0];
    let offset = this.offset;
    // Read the previous denoised frame as its slots are reused for the next input frame.
    // This adds one fixed frame of buffering regardless of the render quantum.
    for (let i = 0; i < output.length; i++) {
      output[i] = Math.max(-1, Math.min(1, this.frame[offset]! / pcmScale));
      this.frame[offset++] = (input?.[i] ?? 0) * pcmScale;
      if (offset === frameSize) {
        this.wasm.rnnoise_process_frame(this.state, this.pointer, this.pointer);
        offset = 0;
        if (!this.started) {
          this.started = true;
          this.port.postMessage('ready');
        }
      }
    }
    this.offset = offset;
    return true;
  }
}

registerProcessor('rajcord-rnnoise', RNNoiseProcessor);
