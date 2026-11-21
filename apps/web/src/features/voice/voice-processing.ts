export const processingKeys = ['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const;
export type MicrophoneProcessing = Readonly<Record<(typeof processingKeys)[number], boolean>>;
export const defaultProcessing: MicrophoneProcessing = Object.freeze({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
});
export const rawProcessing: MicrophoneProcessing = Object.freeze({
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
});
export function processingSettings(value: unknown): MicrophoneProcessing {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== processingKeys.length ||
    !processingKeys.every(
      (key) =>
        Object.hasOwn(value, key) && typeof (value as Record<string, unknown>)[key] === 'boolean',
    )
  )
    throw new Error('Invalid microphone processing settings.');
  return Object.freeze(
    Object.fromEntries(processingKeys.map((key) => [key, (value as Record<string, boolean>)[key]])),
  ) as MicrophoneProcessing;
}
export function appliedProcessing(settings: MediaTrackSettings): Partial<MicrophoneProcessing> {
  return Object.freeze(
    Object.fromEntries(
      processingKeys
        .filter((key) => typeof settings[key] === 'boolean')
        .map((key) => [key, settings[key]]),
    ),
  );
}
export const processingPreferenceKey = (accountId: string) =>
  'rajcord.voice.processing.' + accountId;
