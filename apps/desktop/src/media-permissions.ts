export function trustedAudioRequest(
  target: string,
  url: string,
  isMainFrame: boolean,
  permission: string,
  mediaTypes?: string[],
) {
  try {
    return (
      isMainFrame &&
      new URL(url).origin === new URL(target).origin &&
      permission === 'media' &&
      mediaTypes?.length === 1 &&
      mediaTypes[0] === 'audio'
    );
  } catch {
    return false;
  }
}
export function trustedAudioCheck(
  target: string,
  url: string,
  isMainFrame: boolean,
  permission: string,
  mediaType?: string,
) {
  try {
    return (
      isMainFrame &&
      new URL(url).origin === new URL(target).origin &&
      ((permission === 'media' && mediaType === 'audio') || permission === 'speaker-selection')
    );
  } catch {
    return false;
  }
}
