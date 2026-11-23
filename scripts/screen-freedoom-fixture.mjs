import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';

const execute = promisify(execFile);

// Use the session's disposable configuration and the IWAD's original demo. Only the
// window owned by the PID launched here can be passed to the OBS helper.
export async function launchFreedoom(directory) {
  const exe = process.env.RAJCORD_SCREEN_BENCH_DOOM;
  const wad = process.env.RAJCORD_SCREEN_BENCH_IWAD;
  assert(exe && path.isAbsolute(exe) && path.basename(exe).toLowerCase() === 'chocolate-doom.exe');
  assert(wad && path.isAbsolute(wad) && path.basename(wad).toLowerCase() === 'freedoom2.wad');
  const presentMon = Boolean(process.env.RAJCORD_SCREEN_BENCH_PRESENTMON);
  // Preserve the requested 1920x1080 client area through the game's SDL resize handling.
  await writeFile(path.join(directory, 'extra.cfg'), 'aspect_ratio_correct 0\ninteger_scaling 0\n');
  const game = spawn(
    exe,
    [
      '-iwad',
      wad,
      presentMon ? '-playdemo' : '-timedemo',
      'demo2',
      '-window',
      '-borderless',
      '-width',
      '1920',
      '-height',
      '1080',
      '-nosound',
      '-nomouse',
      '-nograbmouse',
      '-nogui',
      '-config',
      path.join(directory, 'doom.cfg'),
      '-extraconfig',
      path.join(directory, 'extra.cfg'),
      '-savedir',
      directory,
    ],
    {
      cwd: directory,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: false,
      env: { ...process.env, SDL_RENDER_VSYNC: '1' },
    },
  );
  let diagnostics = '';
  game.stderr.on('data', (chunk) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-2048);
  });
  const exited = new Promise((resolve) => game.once('close', resolve));
  let launchError;
  game.on('error', (err) => {
    launchError = err;
  });
  const stop = () => {
    if (game.exitCode === null && game.signalCode === null) game.kill();
  };
  try {
    assert(game.pid, 'Chocolate Doom could not start.');
    const { stdout } = await execute(
      path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p=Get-Process -Id ${game.pid}; for($i=0;$i -lt 60;$i++){ $p.Refresh(); if($p.HasExited){exit 1}; if($p.MainWindowHandle -ne 0){Write-Output "$($p.MainWindowHandle.ToInt64()) $($p.StartTime.ToUniversalTime().Ticks)"; exit 0}; Start-Sleep -Milliseconds 100 }; exit 1`,
      ],
      { windowsHide: true, timeout: 9000 },
    );
    if (launchError) throw launchError;
    const values = /^(\d+) (\d{15,20})$/.exec(stdout.trim());
    assert(values, 'The fixture game did not open its own window.');
    const start = performance.now();
    const until = async (ms) => {
      await delay(Math.max(0, start + ms - performance.now()));
    };
    return {
      target: [values[1], 'identity', String(game.pid), values[2]],
      presentMon,
      until,
      stop,
      measure: async (seconds) => {
        if (presentMon) return gamePresents(game.pid, seconds);
        const timer = setTimeout(stop, 150000);
        try {
          await exited;
          // Chocolate Doom reports successful timedemos through I_Error and returns a nonzero code.
          const result = /timed (\d+) gametics in (\d+) realtics \(([\d.]+) fps\)/i.exec(
            diagnostics,
          );
          assert(result, 'Chocolate Doom did not report its timedemo result.');
          return {
            method: 'Chocolate Doom DEMO2 timedemo',
            gametics: Number(result[1]),
            realtics: Number(result[2]),
            fps: Number(result[3]),
          };
        } finally {
          clearTimeout(timer);
        }
      },
    };
  } catch (error) {
    stop();
    throw error;
  }
}

async function gamePresents(pid, seconds) {
  const executable =
    process.env.RAJCORD_SCREEN_BENCH_PRESENTMON ||
    path.join(
      process.env.ProgramFiles,
      'Intel',
      'PresentMon',
      'PresentMonConsoleApplication',
      'PresentMon-2.4.1-x64.exe',
    );
  const { stdout } = await execute(
    executable,
    [
      '--process_id',
      String(pid),
      '--session_name',
      'RajcordGame' + pid,
      '--v1_metrics',
      '--output_stdout',
      '--no_console_stats',
      '--timed',
      String(seconds),
      '--terminate_after_timed',
      '--terminate_on_proc_exit',
    ],
    { windowsHide: true, timeout: (seconds + 8) * 1000, maxBuffer: 8 * 1024 * 1024 },
  );
  const lines = stdout.trim().split(/\r?\n/);
  const header = lines.findIndex((line) => line.includes('MsBetweenPresents'));
  assert(header >= 0, 'No application presentation counters from PresentMon.');
  const columns = lines[header].split(',');
  const frame = columns.indexOf('MsBetweenPresents'),
    processId = columns.indexOf('ProcessID');
  const intervals = [];
  for (const row of lines.slice(header + 1)) {
    const fields = row.split(',');
    const ms = Number(fields[frame]);
    if (Number(fields[processId]) === pid && Number.isFinite(ms) && ms > 0) intervals.push(ms);
  }
  assert(intervals.length > 2, 'PresentMon received no game frames.');
  intervals.sort((a, b) => a - b);
  const quantile = (p) => intervals[Math.ceil(p * intervals.length) - 1];
  return {
    frames: intervals.length,
    fps: (intervals.length * 1000) / intervals.reduce((a, b) => a + b, 0),
    p95Ms: quantile(0.95),
    p99Ms: quantile(0.99),
    maxMs: intervals.at(-1),
  };
}
