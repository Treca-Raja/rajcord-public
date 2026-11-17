import { Type } from '@sinclair/typebox';
import * as s from './schemas.js';
import { contract } from './route.js';

export const authContracts = [
  contract('GET', '/auth/me', s.auth),
  contract('POST', '/auth/login', s.auth, { body: s.request.authLogin }),
  contract('POST', '/auth/register', s.object({ user: s.user }), {
    body: s.request.authRegister,
    status: 201,
  }),
  contract('POST', '/auth/logout', s.ok),
  contract('POST', '/auth/password/reset', s.ok, { body: s.request.passwordReset }),
  contract(
    'POST',
    '/admin/password-recovery/:id',
    s.object({ code: s.nonempty, expiresAt: s.date }),
    { body: s.request.passwordRecovery },
  ),
  contract(
    'GET',
    '/account/sessions',
    s.object({
      sessions: s.array(
        s.object({
          id: s.nonempty,
          device_label: s.text,
          created_at: s.date,
          expires_at: s.date,
          remember: Type.Boolean(),
          current: Type.Boolean(),
        }),
      ),
    }),
  ),
  contract('DELETE', '/account/sessions/:id', s.ok),
  contract('PATCH', '/account', s.ok, { body: s.request.account }),
  contract('POST', '/account/password', s.ok, { body: s.request.password }),
  contract('GET', '/members', s.object({ users: s.array(s.user) })),
  contract('GET', '/admin/accounts', s.object({ users: s.array(s.user) })),
  contract(
    'GET',
    '/admin/history',
    s.object({
      history: s.array(
        s.object({
          id: s.nonempty,
          actor: s.nonempty,
          target: s.nonempty,
          action: s.nonempty,
          created_at: s.date,
        }),
      ),
    }),
  ),
  contract(
    'POST',
    '/admin/accounts/:id',
    s.object({ ok: s.literal(true), status: s.accountStatus }),
    {
      body: s.request.adminAccount,
    },
  ),
  contract('POST', '/owner/transfer', s.ok, { body: s.request.ownerTransfer }),
] as const;
