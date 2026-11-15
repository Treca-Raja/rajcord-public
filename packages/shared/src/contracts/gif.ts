import { Type } from '@sinclair/typebox';
import * as s from './schemas.js';
import { contract } from './route.js';

export const gifContracts = [
  contract(
    'GET',
    '/gifs/providers',
    s.object({
      providers: s.array(
        s.object({
          id: s.gifProvider,
          label: s.text,
          enabled: Type.Boolean(),
          publicKey: s.optional(s.nonempty),
        }),
      ),
    }),
  ),
  contract(
    'POST',
    '/gifs/search',
    s.object({
      provider: s.gifProvider,
      items: s.array(
        s.object({
          id: s.nonempty,
          title: s.text,
          url: s.nonempty,
          previewUrl: s.nonempty,
          width: s.count,
          height: s.count,
        }),
      ),
      nextCursor: s.nullable(s.text),
      attribution: s.object({ label: s.text, url: s.nonempty }),
      omittedCount: s.count,
    }),
    { body: s.request.gifSearch },
  ),
] as const;
