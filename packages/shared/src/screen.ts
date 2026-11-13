export const SCREEN_PROTOCOL_VERSION = 2;
export const SCREEN_RESOLUTIONS = [480, 720, 1080] as const;
export const SCREEN_FRAME_RATES = [15, 30, 60] as const;
export type ScreenResolution = (typeof SCREEN_RESOLUTIONS)[number];
export type ScreenFrameRate = (typeof SCREEN_FRAME_RATES)[number];
export const SCREEN_PROFILES = ['low', 'auto', 'high', 'smooth', 'ultra'] as const;
export type ScreenProfile = (typeof SCREEN_PROFILES)[number];
// Experimental manual ceilings; these are not qualified performance defaults.
export const SCREEN_VIDEO_BITRATES = [
  2000000, 4000000, 6000000, 8000000, 12000000, 20000000,
] as const;
export type ScreenVideoBitrate = (typeof SCREEN_VIDEO_BITRATES)[number] | null;
export type ScreenSound = 'none' | 'tab' | 'system';
export type ScreenQuality = {
  profile: ScreenProfile;
  videoBitrate: ScreenVideoBitrate;
  resolution?: ScreenResolution;
  frameRate?: ScreenFrameRate;
};
export function screenQualityCeiling(quality: Readonly<ScreenQuality>) {
  const presets = {
    low: { width: 854, height: 480, frameRate: 15 },
    auto: { width: 1280, height: 720, frameRate: 30 },
    high: { width: 1920, height: 1080, frameRate: 30 },
    smooth: { width: 1920, height: 1080, frameRate: 60 },
    ultra: { width: 3840, height: 2160, frameRate: 60 },
  } as const;
  if (quality.resolution !== undefined && quality.frameRate !== undefined)
    return {
      width: { 480: 854, 720: 1280, 1080: 1920 }[quality.resolution],
      height: quality.resolution,
      frameRate: quality.frameRate,
    };
  return presets[quality.profile];
}
export type ScreenErrorCode =
  'not_authorized' | 'stale' | 'capacity' | 'invalid' | 'throttled' | 'unavailable';
export type ScreenAck<T> =
  | { ok: true; data: T }
  | { ok: false; code: ScreenErrorCode; error: string; retryAfterMs?: number };
export type ScreenBoundRequest = { epoch: string };
export type ScreenBindRequest = {
  version: typeof SCREEN_PROTOCOL_VERSION;
  leaseId: string;
  requestId: string;
};
export type ScreenIceServer = { urls: string[]; username?: string; credential?: string };
export type ScreenBinding = {
  epoch: string;
  channelId: string;
  remainingMs: number;
  iceServers?: ScreenIceServer[];
};
export type ScreenPublishRequest = ScreenBoundRequest &
  ScreenQuality & { requestId: string; sourceGeneration: number; sound: ScreenSound };
export type ScreenShare = ScreenQuality & {
  id: string;
  publisherId: string;
  sourceGeneration: number;
  sound: ScreenSound;
};
export type ScreenPublishGrant = { share: ScreenShare; remainingMs: number };
export type ScreenStopRequest = ScreenBoundRequest & { shareId: string };
export type ScreenSelectRequest = ScreenBoundRequest &
  ScreenQuality & { requestId: string; revision: number; shareId: string | null };
export type ScreenLink = {
  id: string;
  shareId: string;
  publisherId: string;
  viewerId: string;
  selectionRevision: number;
  quality: ScreenQuality;
  // Manual ceiling, not measured delivery or a qualified Auto/profile default.
  videoBitrate: ScreenVideoBitrate;
};
export type ScreenLinkGrant = { link: ScreenLink; remainingMs: number };
export type ScreenRenewRequest = ScreenBoundRequest & { requestId: string; revision: number };
export type ScreenRenewal = {
  iceServers?: ScreenIceServer[];
  remainingMs: number;
  links: ScreenLinkGrant[];
  publication: ScreenPublishGrant | null;
};
export type ScreenLinkRequest = ScreenBoundRequest & { linkId: string };
export type ScreenIce = {
  candidate: string;
  sdpMid: string;
  sdpMLineIndex: number;
  usernameFragment: string;
};
export type ScreenSignal = ScreenLinkRequest & {
  revision: number;
  sequence: number;
  payload:
    | { type: 'offer'; sdp: string }
    | { type: 'answer'; sdp: string }
    | { type: 'ice'; candidate: ScreenIce };
};
export type ScreenDirectory = {
  epoch: string;
  revision: number;
  shares: ScreenShare[];
};
export type ScreenLinkNotice = { epoch: string; revision: number; grant: ScreenLinkGrant };
export type ScreenClosed = {
  epoch: string;
  revision: number;
  linkId: string | null;
  reason: 'ended';
};
export type ScreenSignalNotice = Omit<ScreenSignal, 'epoch'> & { epoch: string };
export interface ScreenClientEvents {
  'screen:bind': (data: ScreenBindRequest, ack: (result: ScreenAck<ScreenBinding>) => void) => void;
  'screen:publish': (
    data: ScreenPublishRequest,
    ack: (result: ScreenAck<ScreenPublishGrant>) => void,
  ) => void;
  'screen:stop': (
    data: ScreenStopRequest,
    ack: (result: ScreenAck<{ stopped: true }>) => void,
  ) => void;
  'screen:select': (
    data: ScreenSelectRequest,
    ack: (result: ScreenAck<ScreenLinkGrant | null>) => void,
  ) => void;
  'screen:renew': (
    data: ScreenRenewRequest,
    ack: (result: ScreenAck<ScreenRenewal>) => void,
  ) => void;
  'screen:directory': (
    data: ScreenBoundRequest,
    ack: (result: ScreenAck<ScreenDirectory>) => void,
  ) => void;
  'screen:signal': (
    data: ScreenSignal,
    ack: (result: ScreenAck<{ delivered: true }>) => void,
  ) => void;
}
export interface ScreenServerEvents {
  'screen:directory': (data: ScreenDirectory) => void;
  'screen:link': (data: ScreenLinkNotice) => void;
  'screen:closed': (data: ScreenClosed) => void;
  'screen:signal': (data: ScreenSignalNotice) => void;
}
