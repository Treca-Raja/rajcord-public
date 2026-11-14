import type { TSchema } from '@sinclair/typebox';

export type ApiContract<
  Method extends string = string,
  Path extends string = string,
  Response extends TSchema = TSchema,
  Body extends TSchema | undefined = TSchema | undefined,
  Query extends TSchema | undefined = TSchema | undefined,
> = {
  method: Method;
  path: Path;
  response: Response;
  status: number | undefined;
  body: Body | undefined;
  query: Query | undefined;
};

export const contract = <
  const Method extends string,
  const Path extends string,
  Response extends TSchema,
  Body extends TSchema | undefined = undefined,
  Query extends TSchema | undefined = undefined,
>(
  method: Method,
  path: Path,
  response: Response,
  options: { status?: number; body?: Body; query?: Query } = {},
): ApiContract<Method, Path, Response, Body, Query> => ({
  method,
  path,
  response,
  status: options.status,
  body: options.body,
  query: options.query,
});
