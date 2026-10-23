export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export function input(value: unknown, allowed: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'Invalid request.');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new HttpError(400, 'Unexpected request field.');
  return body;
}
export function text(value: unknown, min: number, max: number, label: string) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max)
    throw new HttpError(400, 'Invalid ' + label + '.');
  return value.trim();
}
export function username(value: unknown) {
  const result = text(value, 3, 32, 'username').toLowerCase();
  if (!/^[a-z0-9_]+$/.test(result))
    throw new HttpError(400, 'Username must use 3–32 letters, numbers or underscores.');
  return result;
}
export function password(value: unknown) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128)
    throw new HttpError(400, 'Use a password between 12 and 128 characters.');
  return value;
}
export function uuid(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new HttpError(400, 'Invalid identifier.');
  return value.toLowerCase();
}
