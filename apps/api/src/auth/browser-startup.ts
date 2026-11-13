import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Test harness only. Never log raw browser output: it can contain profile paths.
export async function waitForBrowserPort(
  child: ChildProcess,
  profile: string,
  timeoutMs = 10000,
): Promise<string> {
  let launchError: string | undefined;
  let startupOutput = '';
  const onError = (error: NodeJS.ErrnoException) => {
    launchError = ['ENOENT', 'EACCES', 'EPERM'].includes(error.code ?? '')
      ? error.code
      : 'spawn error';
  };
  const onStderr = (chunk: Buffer) => {
    startupOutput = (startupOutput + String(chunk)).slice(-8192);
  };
  const failure = (message: string) => {
    const sandboxFailure = /no usable sandbox|namespace|apparmor|zygote_host_impl_linux/i.test(
      startupOutput,
    );
    return new Error(
      message +
        (sandboxFailure
          ? " Chromium's Linux sandbox could not start; use the installed Google Chrome stable binary on Ubuntu CI."
          : ''),
    );
  };
  child.once('error', onError);
  child.stderr?.on('data', onStderr);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (launchError)
        throw failure('Cannot launch the configured test browser (' + launchError + ').');
      if (child.exitCode !== null || child.signalCode !== null)
        throw failure(
          'Headless browser exited before publishing its debugging port (' +
            (child.signalCode ? 'signal ' + child.signalCode : 'exit code ' + child.exitCode) +
            ').',
        );
      let port = '';
      try {
        port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'))
          .split('\n')[0]!
          .trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw failure('Cannot read the test browser debugging-port file.');
      }
      if (/^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535) return port;
      await delay(100);
    }
    throw failure(
      'Headless browser did not publish a valid debugging port within ' + timeoutMs + ' ms.',
    );
  } finally {
    child.removeListener('error', onError);
    child.stderr?.removeListener('data', onStderr);
  }
}
