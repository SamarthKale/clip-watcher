import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/server/db/db.js';
import { buildApp } from '../../src/server/app.js';
import { installCommand, signInCommand, type WindowCommand } from '../../src/server/claude.js';

const H = { 'x-localtube-token': 't0k' };

describe('Claude setup', () => {
  it("installs Claude Code with Anthropic's official Windows installer", () => {
    const c = installCommand();
    expect(c.title).toBe('Set up Claude');
    expect(c.cmd).toBe('powershell.exe');
    expect(c.args.slice(0, 4)).toEqual(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    const script = Buffer.from(c.args[4], 'base64').toString('utf16le');
    expect(script).toContain('irm https://claude.ai/install.ps1 | iex');
  });

  it("signs in with the user's own Claude Code (where the installer put it, else on PATH)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home '));
    expect(signInCommand(home)).toEqual({ title: 'Claude sign-in', cmd: 'claude', args: [] });
    const exe = path.join(home, '.local', 'bin', 'claude.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '');
    expect(signInCommand(home)).toEqual({ title: 'Claude sign-in', cmd: exe, args: [] });
  });

  it('the setup routes need the app token', async () => {
    const launched: WindowCommand[] = [];
    const app = buildApp({ db: openDb(':memory:'), token: 't0k', launch: (c) => launched.push(c) });
    expect((await app.inject({ method: 'POST', url: '/api/claude/install' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/claude/signin' })).statusCode).toBe(401);
    expect(launched).toHaveLength(0);
  });

  it('opens one window per click: the installer, then the sign-in', async () => {
    const launched: WindowCommand[] = [];
    const app = buildApp({ db: openDb(':memory:'), token: 't0k', launch: (c) => launched.push(c) });
    const r = await app.inject({ method: 'POST', url: '/api/claude/install', headers: H });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ started: true });
    expect(launched).toEqual([installCommand()]);
    await app.inject({ method: 'POST', url: '/api/claude/signin', headers: H });
    expect(launched[1].title).toBe('Claude sign-in');
  });
});
