import { isIP } from 'node:net';
import {
  parseScreenDescription,
  parseScreenIce,
  parseScreenSignal,
  screenPositive,
  ScreenSignalingError,
} from '@tricord/shared';
import { HttpError } from '../auth/validation.js';
const address = (value: string) => !!isIP(value) || /^[a-zA-Z0-9-]{1,63}\.local$/.test(value);
function parsed<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof ScreenSignalingError) throw new HttpError(400, error.message);
    throw error;
  }
}
export type { ScreenDescription as Description } from '@tricord/shared';
export const positive = (value: unknown) => parsed(() => screenPositive(value));
export const ice = (value: unknown) => parsed(() => parseScreenIce(value, address));
export const description = (sdp: string, type: 'offer' | 'answer') =>
  parsed(() => parseScreenDescription(sdp, type, address));
export const signal = (value: unknown) => parsed(() => parseScreenSignal(value, address));
