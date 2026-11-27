import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';

/**
 * Claude, set up from inside Spikecut. The Claude Code program can't ship inside Spikecut and every
 * user signs in with their own Claude account, so these open a visible window that runs Anthropic's
 * official installer, and then Claude Code itself for the sign-in.
 */
export interface WindowCommand {
  title: string;
  cmd: string;
  args: string[];
}

const INSTALL_SCRIPT = [
  "Write-Host 'Installing Claude Code with the official installer from claude.ai ...'",
  'irm https://claude.ai/install.ps1 | iex',
  "Write-Host ''",
  "Write-Host 'Done. Go back to Spikecut and press Sign in to Claude.'",
  "Read-Host 'Press Enter to close this window'",
].join('\n');

export function installCommand(): WindowCommand {
  // -EncodedCommand (UTF-16LE, base64) keeps the script's pipe away from cmd.exe's quoting.
  const encoded = Buffer.from(INSTALL_SCRIPT, 'utf16le').toString('base64');
  return { title: 'Set up Claude', cmd: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded] };
}

export function signInCommand(home: string = os.homedir()): WindowCommand {
  const exe = path.join(home, '.local', 'bin', 'claude.exe'); // where the installer puts it
  return { title: 'Claude sign-in', cmd: fs.existsSync(exe) ? exe : 'claude', args: [] };
}

/** Opens the command in its own console window, so the user sees it and can answer it. */
export function launchInWindow(c: WindowCommand): void {
  const q = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '')}"` : s);
  const line = `start "${c.title}" ${[c.cmd, ...c.args].map(q).join(' ')}`;
  spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
}

export function registerClaudeRoutes(app: FastifyInstance, launch: (c: WindowCommand) => void): void {
  app.post('/api/claude/install', async () => {
    launch(installCommand());
    return { started: true };
  });
  app.post('/api/claude/signin', async () => {
    launch(signInCommand());
    return { started: true };
  });
}
