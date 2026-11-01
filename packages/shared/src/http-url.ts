/** Accept explicit web URLs only, without credentials or browser-normalized whitespace. */
export function safeHttpUrl(value: string): string | undefined {
  if (
    !/^https?:\/\/[^/]/i.test(value) ||
    /[\s\\]/u.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    return;
  try {
    const url = new URL(value);
    if (!url.hostname || url.username || url.password) return;
    return url.href;
  } catch {
    return;
  }
}
