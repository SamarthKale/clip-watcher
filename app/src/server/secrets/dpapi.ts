import { spawn } from 'node:child_process';

// Data goes in and out as base64 over stdin/stdout, so no secret ever appears on a command line.
const script = (op: 'Protect' | 'Unprotect') => `
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($in)
$out = [System.Security.Cryptography.ProtectedData]::${op}($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($out))
`;

function run(op: 'Protect' | 'Unprotect', inputB64: string): Promise<string> {
  const encoded = Buffer.from(script(op), 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true });
    let out = '';
    let err = '';
    ps.stdout.on('data', (d) => (out += d));
    ps.stderr.on('data', (d) => (err += d));
    ps.on('error', reject);
    ps.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`DPAPI ${op} failed: ${err.trim().slice(0, 200)}`))));
    ps.stdin.end(inputB64);
  });
}

/** Encrypts text with Windows DPAPI (CurrentUser scope). Returns base64. */
export async function protect(plain: string): Promise<string> {
  return run('Protect', Buffer.from(plain, 'utf8').toString('base64'));
}

export async function unprotect(cipher: string): Promise<string> {
  return Buffer.from(await run('Unprotect', cipher), 'base64').toString('utf8');
}
