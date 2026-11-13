import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

export function signatureMatches(raw: string, publishers: string[], file: string): boolean {
  try {
    const data = JSON.parse(raw);
    return (
      data.Status === 0 &&
      data.SignatureType === 1 && // Embedded Authenticode; catalog signatures are not accepted.
      typeof data.Path === 'string' &&
      path.win32.normalize(data.Path).toLowerCase() === path.win32.normalize(file).toLowerCase() &&
      publishers.some((dn) => dn.startsWith('CN=') && dn === data.SignerCertificate?.Subject)
    );
  } catch {
    return false;
  }
}

// electron-updater 6's default verifier has a PowerShell-unavailable fallback.
// Use its supported verifier hook and reject every unavailable/ambiguous result.
export async function verifyUpdateSignature(publishers: string[], file: string) {
  try {
    const script =
      "$ErrorActionPreference='Stop'; $WarningPreference='Stop'; $ProgressPreference='SilentlyContinue'; $s = Get-AuthenticodeSignature -LiteralPath $env:RAJCORD_SIGNATURE_FILE; [pscustomobject]@{ Status=[int]$s.Status; SignatureType=[int]$s.SignatureType; Path=$s.Path; SignerCertificate=@{Subject=$s.SignerCertificate.Subject} } | ConvertTo-Json -Compress";
    const { stdout, stderr } = await promisify(execFile)(
      path.win32.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        windowsHide: true,
        timeout: 20000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PSModulePath: '', RAJCORD_SIGNATURE_FILE: file },
      },
    );
    return !stderr && signatureMatches(stdout, publishers, file)
      ? null
      : 'The update has no valid embedded signature from the trusted publisher.';
  } catch {
    return 'Windows could not verify the update signature. Installation was blocked.';
  }
}
