import { expect, it, vi } from 'vitest';
import { applyScreenVideoPlan, screenVideoPlan, screenVideoRequest } from './screen-quality';

const settings = { width: 1920, height: 1080, frameRate: 60 };
const request = (
  revision = 1,
  publisher = 'smooth',
  viewer = 'smooth',
  pub = 8000000,
  view = 4000000,
) => ({
  revision,
  publisher: { profile: publisher, videoBitrate: pub },
  viewer: { profile: viewer, videoBitrate: view },
});
it('manual bitrate is independent of profile/frame ceilings and clamps both accounts', () => {
  const low = screenVideoPlan(request(1, 'smooth', 'low', 8000000, 4000000), settings);
  expect(low.encoding).toEqual({
    maxBitrate: 4000000,
    maxFramerate: 15,
    scaleResolutionDownBy: 2.25,
  });
  expect(screenVideoPlan(request(1, 'smooth', 'low', 2000000, 8000000), settings).encoding).toEqual(
    { ...low.encoding, maxBitrate: 2000000 },
  );
  expect(screenVideoPlan(request(1, 'high', 'smooth'), settings).encoding.maxFramerate).toBe(30);
});
it.each([
  { width: 320, height: 180, frameRate: 20 },
  { width: 640, height: 480, frameRate: 29.97 },
])('never upscales smaller source %j or invents temporal cadence', (source) => {
  expect(screenVideoPlan(request(), source).encoding).toEqual({
    maxBitrate: 4000000,
    maxFramerate: source.frameRate,
    scaleResolutionDownBy: 1,
  });
});
it('uses one aspect-preserving scale for portrait and wide sources', () => {
  expect(
    screenVideoPlan(request(), { width: 1080, height: 1920, frameRate: 30 }).encoding
      .scaleResolutionDownBy,
  ).toBe(1920 / 1080);
  expect(
    screenVideoPlan(request(), { width: 3840, height: 1080, frameRate: 60 }).encoding
      .scaleResolutionDownBy,
  ).toBe(2);
});
it.each([
  request(1, 'auto'),
  request(1, 'ultra'),
  { ...request(), publisher: { profile: 'smooth', videoBitrate: null } },
])('leaves Auto/Ultra unqualified %#', (value) => {
  expect(() => screenVideoPlan(value, settings)).toThrow(
    expect.objectContaining({ code: 'unqualified' }),
  );
});
it.each([
  null,
  {},
  { ...request(), revision: 0 },
  { ...request(), revision: Number.MAX_SAFE_INTEGER + 1 },
  request(1, 'fake'),
  request(1, 'smooth', 'smooth', 3000000),
  { ...request(), authorized: true },
  { ...request(), viewer: { ...request().viewer, leaseId: 'fake' } },
])('rejects malformed controls %#', (value) => {
  expect(() => screenVideoRequest(value)).toThrow();
});
it.each([
  { width: 0, height: 1080, frameRate: 60 },
  { width: 1920, height: 1080 },
  { width: 1920, height: 1080, frameRate: NaN },
  { width: 1.5, height: 2, frameRate: 30 },
])('requires usable source metadata %#', (source) => {
  expect(() => screenVideoPlan(request(), source)).toThrow(
    expect.objectContaining({ code: 'unqualified' }),
  );
});
it('copies and freezes only numeric source data and explicit manual choices', () => {
  const value = request(),
    source = { ...settings, deviceId: 'private-device' };
  const plan = screenVideoPlan(value, source);
  value.viewer.videoBitrate = 2000000;
  source.width = 1;
  expect(plan.request.viewer.videoBitrate).toBe(4000000);
  expect(plan.source.width).toBe(1920);
  expect(Object.keys(plan.source).sort()).toEqual(['frameRate', 'height', 'width']);
  expect(
    [
      plan,
      plan.encoding,
      plan.source,
      plan.request,
      plan.request.publisher,
      plan.request.viewer,
      plan.ceiling,
    ].every(Object.isFrozen),
  ).toBe(true);
});
function sender() {
  let encoding = {
    active: true,
    rid: 'owned',
    maxBitrate: 8000000,
    maxFramerate: 60,
    scaleResolutionDownBy: 1,
  };
  let transaction = 0;
  const getParameters = vi.fn((): RTCRtpSendParameters => ({
    transactionId: String(++transaction),
    codecs: [],
    headerExtensions: [],
    rtcp: { cname: 'owned', reducedSize: true },
    encodings: [{ ...encoding }],
  }));
  const setParameters = vi.fn(async (parameters: RTCRtpSendParameters) => {
    encoding = { ...encoding, ...parameters.encodings[0] };
  });
  return { getParameters, setParameters, track: null };
}
it('uses the fresh native transaction and preserves unrelated sender encoding fields', async () => {
  const native = sender(),
    plan = screenVideoPlan(request(), settings),
    check = vi.fn();
  const applied = await applyScreenVideoPlan(native, plan, (raw) => raw, check);
  expect(native.setParameters.mock.calls[0]![0]).toMatchObject({
    transactionId: '1',
    rtcp: { cname: 'owned' },
    encodings: [{ active: true, rid: 'owned', ...plan.encoding }],
  });
  expect(native.getParameters).toHaveBeenCalledTimes(2);
  expect(applied.encoding).toEqual(plan.encoding);
  expect(Object.isFrozen(applied.encoding)).toBe(true);
});
it('reports a stricter native ceiling as observed, never as achieved throughput', async () => {
  const native = sender();
  native.getParameters.mockReturnValueOnce({
    transactionId: 'initial',
    codecs: [],
    headerExtensions: [],
    rtcp: { cname: 'owned', reducedSize: true },
    encodings: [
      {
        active: true,
        rid: 'owned',
        maxBitrate: 8000000,
        maxFramerate: 60,
        scaleResolutionDownBy: 1,
      },
    ],
  });
  native.setParameters.mockImplementation(async () => {
    native.getParameters.mockReturnValue({
      transactionId: 'clamped',
      codecs: [],
      headerExtensions: [],
      rtcp: { cname: 'owned', reducedSize: true },
      encodings: [
        {
          active: true,
          rid: 'owned',
          maxBitrate: 2000000,
          maxFramerate: 30,
          scaleResolutionDownBy: 2,
        },
      ],
    });
  });
  const result = await applyScreenVideoPlan(
    native,
    screenVideoPlan(request(), settings),
    (raw) => raw,
    () => {},
  );
  expect(result.encoding).toEqual({
    maxBitrate: 2000000,
    maxFramerate: 30,
    scaleResolutionDownBy: 2,
  });
});
it.each(['bitrate', 'fps', 'upscale', 'missing', 'simulcast'] as const)(
  'does not claim an unsupported native %s result',
  async (mode) => {
    const native = sender();
    native.setParameters.mockImplementation(async () => {
      const parameters = native.getParameters();
      if (mode === 'simulcast') parameters.encodings.push({ ...parameters.encodings[0]! });
      else if (mode === 'missing') parameters.encodings = [];
      else if (mode === 'bitrate') parameters.encodings[0]!.maxBitrate = 20000000;
      else if (mode === 'fps') parameters.encodings[0]!.maxFramerate = 120;
      else parameters.encodings[0]!.scaleResolutionDownBy = 0.5;
      native.getParameters.mockReturnValue(parameters);
    });
    await expect(
      applyScreenVideoPlan(
        native,
        screenVideoPlan(request(), settings),
        (raw) => raw,
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });
  },
);
