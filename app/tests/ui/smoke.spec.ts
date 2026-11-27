import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture } from '../fixtures/make-fixtures';

/** Clicks a sidebar link (the dashboard text also links to some pages). */
const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name }).click();

let server: ChildProcess;
let url = '';
let videosDir = '';

test.beforeAll(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-ui-data-'));
  videosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-ui-videos-'));
  fs.copyFileSync(fixture('short'), path.join(videosDir, 'my clip.mp4'));
  server = spawn(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), 'src/server/index.ts'], {
    env: { ...process.env, LOCALTUBE_DATA: data, PORT: '4519', LOCALTUBE_NO_OPEN: '1', LOCALTUBE_TEST_PICK_DIR: videosDir },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  url = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 30_000);
    server.stdout!.on('data', (d: Buffer) => {
      const m = d.toString().match(/LocalTube running: (\S+)/);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    server.on('exit', (c) => reject(new Error(`server exited early (${c})`)));
  });
});
test.afterAll(() => {
  server?.kill();
});

test('add a folder, scan it, edit metadata by hand, and never expose the API key', async ({ page }) => {
  await page.goto(url);

  // The launch token is removed from the address bar after load.
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect.poll(() => page.url()).not.toContain('token=');
  await expect(page.getByText('No data yet')).toBeVisible();

  // Folders: add through the (stubbed) folder dialog, then scan.
  await nav(page, 'Folders');
  await page.getByRole('button', { name: 'Add folder' }).click();
  await expect(page.getByTestId('folder-name')).toHaveText(path.basename(videosDir));
  await page.getByRole('button', { name: 'Scan now' }).click();
  await expect(page.getByTestId('scan-result')).toContainText('Found 1', { timeout: 30_000 });

  // Upload a clip JSON through the UI: its text is applied to the matching video.
  const clipJson = { stream: { name: 'Test stream' }, clips: [{ file: 'my clip.mp4', post_title: 'Imported from JSON', description: 'Imported description', hashtags: ['#openworld', '#shorts'], hook_text: 'Hook', reason: 'spike' }] };
  await page.getByLabel('Clip JSON file').setInputFiles({ name: 'clips.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(clipJson)) });
  await expect(page.getByTestId('scan-result')).toContainText('clips.json: 1 updated');

  // Library: the video is listed with its duration, and its title came from the JSON.
  await nav(page, 'Video Library');
  const row = page.getByTestId('video-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('my clip.mp4');
  await expect(row).toContainText('0:01');
  await expect(row).toContainText('Imported from JSON');
  await expect(row).toContainText('From JSON');

  // Edit metadata by hand, save, reload, and see it persisted.
  await row.getByRole('button', { name: 'my clip.mp4' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit metadata' });
  await dialog.getByLabel(/^Title/).fill('Insane 1v4 clutch');
  await dialog.getByLabel('Description').fill('Watch this comeback.');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog.getByText('Saved')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('video-row')).toContainText('Insane 1v4 clutch');
  await expect(page.getByTestId('video-row')).toContainText('Written by you');

  // The shell shows the pipeline on the dashboard.
  await nav(page, 'Dashboard');
  await expect(page.getByTestId('count-detected')).toHaveText('1');
  await expect(page.getByTestId('count-metadataReady')).toHaveText('1');

  // Settings: the Gemini key is write-only and never shown back.
  await nav(page, 'Settings');
  await page.getByLabel('Gemini API key').fill('SECRET-KEY-VALUE-123');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByRole('status')).toContainText('API key saved');
  await page.reload();
  await expect(page.getByText('saved; enter a new one to replace')).toBeVisible();
  expect(await page.content()).not.toContain('SECRET-KEY-VALUE-123');
  expect(await page.getByLabel('Gemini API key').inputValue()).toBe('');

  // Refresh and a fresh tab with NO token in the address still show the saved data (session cookie).
  await page.goto(url.split('#')[0] + '#/library');
  await expect(page.getByTestId('video-row')).toContainText('Insane 1v4 clutch');
  const second = await page.context().newPage();
  await second.goto(url.split('#')[0] + '#/folders');
  await expect(second.getByTestId('folder-name')).toHaveText(path.basename(videosDir));
  await second.close();

  // The source video was never touched.
  expect(fs.readdirSync(videosDir)).toEqual(['my clip.mp4']);
});
