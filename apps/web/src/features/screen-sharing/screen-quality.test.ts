import { expect, it, vi } from 'vitest';
import { applyScreenVideoPlan, screenVideoPlan, screenVideoRequest } from './screen-quality';

const settings = { width: 1920, height: 1080, frameRate: 60 };
const fixedChoice = { profile: 'smooth', resolution: 1080, frameRate: 60, videoBitrate: 8000000 };
const fixedRequest = { revision: 1, publisher: fixedChoice };
it('uses actual legacy capture settings when the broadcaster uses a preset', () => {
  const publisher = { profile: 'smooth', videoBitrate: 8000000 };
  expect(
    screenVideoPlan({ revision: 1, publisher }, { width: 1600, height: 900, frameRate: 30 }),
  ).toMatchObject({
    qualification: 'experimental-ceilings',
    encoding: { maxBitrate: 8000000, maxFramerate: 30, scaleResolutionDownBy: 1 },
  });
});
it('preserves explicit ultrawide height and caps delivery at the current source format', () => {
  expect(
    screenVideoPlan(fixedRequest, { ...settings, width: 2560 }).encoding.scaleResolutionDownBy,
  ).toBe(1);
  expect(
    screenVideoPlan(fixedRequest, { width: 1280, height: 720, frameRate: 30 }).encoding,
  ).toEqual({ scaleResolutionDownBy: 1, maxFramerate: 30, maxBitrate: 8000000 });
});
it.each(
  [480, 720, 1080].flatMap((resolution) =>
    [15, 30, 60].map((frameRate) => ({ resolution, frameRate })),
  ),
)(
  'selects $resolution p at $frameRate fps independently from bitrate and legacy profile',
  (choice) => {
    const quality = { profile: 'smooth', videoBitrate: 8000000, ...choice };
    const plan = screenVideoPlan({ revision: 1, publisher: quality }, settings);
    expect(plan.ceiling.height).toBe(choice.resolution);
    expect(plan.encoding.maxFramerate).toBe(choice.frameRate);
    expect(plan.encoding.maxBitrate).toBe(8000000);
    expect(plan.encoding.scaleResolutionDownBy).toBeCloseTo(1080 / choice.resolution);
  },
);
it.each([
  { resolution: 720 },
  { frameRate: 60 },
  { resolution: 0, frameRate: 30 },
  { resolution: 2160, frameRate: 60 },
  { resolution: 720, frameRate: 120 },
  { resolution: '720', frameRate: 30 },
  { resolution: 720, frameRate: NaN },
])('rejects incomplete or unsupported explicit video controls %j', (choice) => {
  const quality = { profile: 'smooth', videoBitrate: 8000000, ...choice };
  expect(() => screenVideoPlan({ revision: 1, publisher: quality }, settings)).toThrow();
});
const request = (revision = 1, profile = 'smooth', videoBitrate = 8000000) => ({
  revision,
  publisher: { profile, videoBitrate },
});
it.each([2000000, 4000000, 6000000, 8000000, 12000000, 20000000])(
  'uses the broadcaster bitrate %i independently of the selected format',
  (bitrate) => {
    expect(screenVideoPlan(request(1, 'low', bitrate), settings).encoding).toEqual({
      maxBitrate: bitrate,
      maxFramerate: 15,
      scaleResolutionDownBy: 2.25,
    });
  },
);
it.each([
  { width: 320, height: 180, frameRate: 20 },
  { width: 640, height: 480, frameRate: 29.97 },
])('never upscales smaller source %j or invents temporal cadence', (source) => {
  expect(screenVideoPlan(request(), source).encoding).toEqual({
    maxBitrate: 8000000,
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
  request(1, 'smooth', 3000000),
  { ...request(), authorized: true },
  { ...request(), viewer: { profile: 'low', videoBitrate: 2000000 } },
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
  value.publisher.videoBitrate = 2000000;
  source.width = 1;
  expect(plan.request.publisher.videoBitrate).toBe(8000000);
  expect(plan.source.width).toBe(1920);
  expect(Object.keys(plan.source).sort()).toEqual(['frameRate', 'height', 'width']);
  expect(
    [plan, plan.encoding, plan.source, plan.request, plan.request.publisher, plan.ceiling].every(
      Object.isFrozen,
    ),
  ).toBe(true);
});
function sender() {
  let degradationPreference: RTCRtpSendParameters['degradationPreference'];
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
    degradationPreference,
  }));
  const setParameters = vi.fn(async (parameters: RTCRtpSendParameters) => {
    degradationPreference = parameters.degradationPreference;
    encoding = { ...encoding, ...parameters.encodings[0] };
  });
  return { getParameters, setParameters, track: null };
}
it('confirms the fixed encoder policy and rejects a sender that silently substitutes another setting', async () => {
  const native = sender(),
    plan = screenVideoPlan(fixedRequest, settings);
  const apply = () =>
    applyScreenVideoPlan(
      native,
      plan,
      (raw) => raw,
      () => {},
    );
  await expect(apply()).resolves.toMatchObject({ encoding: plan.encoding });
  expect(native.getParameters().degradationPreference).toBe('maintain-framerate');
  for (const override of [
    { maxFramerate: 50 },
    { scaleResolutionDownBy: 1.5 },
    { maxBitrate: 4000000 },
  ]) {
    const observed = native.getParameters();
    Object.assign(observed.encodings[0]!, override);
    native.getParameters.mockReturnValueOnce(native.getParameters()).mockReturnValueOnce(observed);
    await expect(apply()).rejects.toThrow('did not retain');
  }
});
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
