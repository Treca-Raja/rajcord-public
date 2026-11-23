import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { stdin, stderr } from 'node:process';

export class AudioPermissionUnconfirmed extends Error {
  constructor(reason) {
    super('Windows audio result inconclusive: ' + reason);
  }
}

export function requireAudioTerminal(input = stdin, output = stderr) {
  if (!input.isTTY || !output.isTTY) {
    throw new AudioPermissionUnconfirmed(
      'open an interactive Windows terminal and stay present to approve audio permissions.',
    );
  }
}

export function audioConsoleDiagnostic(row, debug) {
  return (
    row.length > 0 &&
    (debug || row.startsWith('wasapi stage=')) &&
    !/^wasapi stage=IAudioCaptureClient\.ReleaseBuffer .* hr=0x00000000$/.test(row)
  );
}

export async function confirmAudioPermissions(
  message,
  { input = stdin, output = stderr, signal = AbortSignal.timeout(45000), warmup = false } = {},
) {
  requireAudioTerminal(input, output);
  const consoleInput = createInterface({ input, output, terminal: true });
  try {
    output.write(
      '\n' +
        message +
        (warmup
          ? '\nType READY to open the audio devices and handle any Kaspersky prompts.\n> '
          : '\nType GRANTED only if Kaspersky granted the required audio access and no prompt is pending.\n> '),
    );
    const [answer] = await Promise.race([
      once(consoleInput, 'line', { signal }),
      once(consoleInput, 'close', { signal }).then(() => []),
    ]);
    if (answer?.trim() === (warmup ? 'READY' : 'GRANTED')) return;
    throw new AudioPermissionUnconfirmed('the operator did not confirm this audio checkpoint.');
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
    throw new AudioPermissionUnconfirmed('audio permission confirmation timed out.');
  } finally {
    consoleInput.close();
  }
}
