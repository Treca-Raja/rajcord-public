import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';

type Worklet = {
  port: { postMessage: (message: unknown) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
};

afterEach(() => vi.unstubAllGlobals());

it('renders variable quanta with one fixed frame of buffering and no missing samples', async () => {
  class Processor {
    port = { postMessage: vi.fn() };
  }
  const register = vi.fn<(name: string, Worklet: new (options: unknown) => Worklet) => void>();
  vi.stubGlobal('sampleRate', 48000);
  vi.stubGlobal('AudioWorkletProcessor', Processor);
  vi.stubGlobal('registerProcessor', register);
  await import('./rnnoise-worklet');
  const [name, RNNoise] = register.mock.calls[0]!;
  expect(name).toBe('rajcord-rnnoise');
  const bytes = await readFile(new URL('./rnnoise.wasm', import.meta.url));
  const module = await WebAssembly.compile(bytes);
  const processor = new RNNoise({ processorOptions: { module } });
  const reference = new WebAssembly.Instance(module).exports as {
    memory: WebAssembly.Memory;
    _initialize(): void;
    malloc(size: number): number;
    rnnoise_create(model: number): number;
    rnnoise_process_frame(state: number, output: number, input: number): number;
  };
  reference._initialize();
  const state = reference.rnnoise_create(0);
  const pointer = reference.malloc(480 * 4);
  const frame = new Float32Array(reference.memory.buffer, pointer, 480);
  let seed = 1;
  const source = Float32Array.from({ length: 48000 * 3 }, (_, i) => {
    if (i < 512) return 0;
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return 0.05 * (seed / 0x100000000 - 0.5) + Math.sin(i * 0.034) * 0.4;
  });
  const expected = new Float32Array(source.length);
  for (let offset = 0; offset < source.length - 480; offset += 480) {
    for (let i = 0; i < 480; i++) frame[i] = source[offset + i]! * 32768;
    reference.rnnoise_process_frame(state, pointer, pointer);
    for (let i = 0; i < 480; i++) {
      expected[offset + 480 + i] = Math.max(-1, Math.min(1, frame[i]! / 32768));
    }
  }
  expect(expected.some((sample) => sample !== 0)).toBe(true);
  const sizes = [128, 256, 128, 193, 64, 1024];
  for (let offset = 0, index = 0; offset < source.length; index++) {
    const end = Math.min(source.length, offset + sizes[index % sizes.length]!);
    const output = new Float32Array(end - offset);
    const input = offset < 512 && end <= 512 ? [] : [[source.subarray(offset, end)]];
    expect(processor.process(input, [[output]])).toBe(true);
    expect(output).toEqual(expected.subarray(offset, end));
    offset = end;
  }
  expect(processor.port.postMessage).toHaveBeenCalledExactlyOnceWith('ready');
  vi.stubGlobal('sampleRate', 44100);
  expect(() => new RNNoise({ processorOptions: { module } })).toThrow('48 kHz');
});
