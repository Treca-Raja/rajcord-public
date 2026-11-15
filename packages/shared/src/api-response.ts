import { Value } from '@sinclair/typebox/value';
import type { Static, TSchema } from '@sinclair/typebox';
import * as schemas from './contracts/schemas.js';
import type { ApiContract } from './contracts/route.js';
import { authContracts } from './contracts/auth.js';
import { chatContracts } from './contracts/chat.js';
import { gifContracts } from './contracts/gif.js';
import { voiceContracts } from './contracts/voice.js';
import { screenContracts } from './contracts/screen.js';

export const API_CONTRACTS = [
  ...authContracts,
  ...chatContracts,
  ...gifContracts,
  ...voiceContracts,
  ...screenContracts,
] as const satisfies readonly ApiContract[];

export const API_ERROR_RESPONSE = schemas.errorResponse;
type ApiRoute = (typeof API_CONTRACTS)[number];
type ExpandPath<Path extends string> = Path extends `${infer Prefix}:${string}/${infer Rest}`
  ? `${Prefix}${string}/${ExpandPath<Rest>}`
  : Path extends `${infer Prefix}:${string}`
    ? `${Prefix}${string}`
    : Path;
export type ApiClientPath = ExpandPath<ApiRoute['path']>;
type ExpandRoute<Route> = Route extends ApiRoute
  ? { path: ExpandPath<Route['path']>; route: Route }
  : never;
type ExpandedApiRoute = ExpandRoute<ApiRoute>;
type RouteAt<Path extends ApiClientPath> = ExpandedApiRoute extends infer Entry
  ? Entry extends { path: infer Match extends string; route: infer Route }
    ? Path extends Match
      ? Route
      : never
    : never
  : never;
export type ApiMethodForPath<Path extends ApiClientPath> =
  RouteAt<Path> extends {
    method: infer Method extends string;
  }
    ? Method
    : never;
export type ApiGetPath = ExpandPath<Extract<ApiRoute, { method: 'GET' }>['path']>;
type RouteFor<Path extends ApiClientPath, Method extends string> = Extract<
  RouteAt<Path>,
  { method: Method }
>;
export type ApiResponseFor<Path extends ApiClientPath, Method extends string> = Static<
  RouteFor<Path, Method>['response']
>;
export type ApiRequestBodyFor<Path extends ApiClientPath, Method extends string> =
  NonNullable<RouteFor<Path, Method>['body']> extends infer Body
    ? Body extends TSchema
      ? Static<Body>
      : undefined
    : undefined;

export class InvalidApiResponseError extends Error {
  readonly code = 'INVALID_API_RESPONSE';
  constructor() {
    super('The server returned an invalid response. Please retry.');
    this.name = 'InvalidApiResponseError';
  }
}

export class InvalidApiRequestError extends Error {
  readonly code = 'INVALID_API_REQUEST';
  constructor() {
    super('The request does not match this API contract.');
    this.name = 'InvalidApiRequestError';
  }
}

function normalizePath(path: string) {
  const pathname = path.split('?')[0]!.replace(/\/$/, '');
  return pathname.startsWith('/api/') ? pathname.slice(4) : pathname;
}

function matches(template: string, pathname: string) {
  const expression = template
    .split('/')
    .map((part) => (part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${expression}$`).test(pathname);
}

function findContract(path: string, method: string) {
  const pathname = normalizePath(path);
  const verb = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return API_CONTRACTS.find((entry) => entry.method === verb && matches(entry.path, pathname));
}

export function getApiContract(path: string, method: string) {
  return findContract(path, method);
}

export function validateApiResponse(path: string, method: string, value: unknown): void {
  const contract = findContract(path, method);
  if (!contract || !Value.Check(contract.response, value)) throw new InvalidApiResponseError();
}

export function validateApiRequest(path: string, method: string, body: unknown): void {
  const contract = findContract(path, method);
  if (!contract || (contract.body && !Value.Check(contract.body, body)))
    throw new InvalidApiRequestError();
  const querySchema = contract.query;
  if (querySchema) {
    let url: URL;
    try {
      url = new URL(path, 'http://rajcord.invalid');
    } catch {
      throw new InvalidApiRequestError();
    }
    const query = Object.fromEntries(url.searchParams.entries());
    if (!Value.Check(querySchema, query)) throw new InvalidApiRequestError();
  }
}
