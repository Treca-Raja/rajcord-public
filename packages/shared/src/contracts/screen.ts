import * as s from './schemas.js';
import { contract } from './route.js';

export const screenContracts = [
  contract('POST', '/screen/capture/prepare', s.capture, { body: s.request.capturePrepare }),
  contract('POST', '/screen/capture/check', s.capture, { body: s.request.captureVerify }),
  contract('POST', '/screen/capture/consume', s.capture, { body: s.request.captureVerify }),
  contract('POST', '/screen/capture/cancel', s.cancelled, { body: s.request.captureCancel }),
  contract('POST', '/screen/capture/handoff', s.capture, { body: s.request.captureHandoff }),
  contract('POST', '/screen/capture/publication-check', s.publicationCheck, {
    body: s.request.publicationCheck,
  }),
  contract('POST', '/screen/capture/publication-cancel', s.cancelled, {
    body: s.request.publicationCancel,
  }),
] as const;
