import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function taskkill(pid: number, force: boolean): Promise<void> {
  try {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true });
  } catch (error) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    throw error;
  }
}

async function windowsDescendants(rootPid: number): Promise<number[]> {
  const script = fileURLToPath(new URL('./windows-process-tree.ps1', import.meta.url));
  const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-RootProcessId', String(rootPid)], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed) || !parsed.every((item) => Number.isSafeInteger(item) && item > 0)) throw new Error('Windows process tree helper returned invalid output');
  return parsed as number[];
}

function killDirectly(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    throw error;
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

export async function terminateProcessTree(pid: number, graceMilliseconds = 1000): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  if (process.platform === 'win32') {
    try {
      await taskkill(pid, true);
    } catch {
      for (const descendant of await windowsDescendants(pid)) killDirectly(descendant);
      killDirectly(pid);
    }
    return;
  }

  if (!signalProcessGroup(pid, 'SIGTERM')) return;
  await delay(graceMilliseconds);
  signalProcessGroup(pid, 'SIGKILL');
}
