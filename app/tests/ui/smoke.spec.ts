import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture } from '../fixtures/make-fixtures';

/** Clicks a sidebar link (the dashboard text also links to some pages). */
const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name }).click();
/** Pages that are no longer in the sidebar (folders are automatic) are still reachable by address. */
const open = async (page: Page, route: string) => {
  await page.goto(url.split('#')[0] + '#/' + route);
};

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

  // The launch token is removed from the address bar after load; Home is the landing page.
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect.poll(() => page.url()).not.toContain('token=');

  // First run: the tour opens by itself, walks through the pages, and is remembered once skipped.
  const tour = page.getByRole('dialog', { name: 'Spikecut tour' });
  await expect(tour).toBeVisible();
  await expect(tour).toContainText('Welcome to Spikecut');
  await tour.getByRole('button', { name: 'Start the tour' }).click();
  await expect(tour).toContainText('Five stages, fully automatic');
  await tour.getByRole('button', { name: 'Next' }).click();
  await expect(tour).toContainText('Start watching a channel');
  await tour.getByRole('button', { name: 'Next' }).click();
  await expect(tour).toContainText('Every moment chat exploded');
  await expect(page.getByRole('heading', { name: 'Spikes & clips' })).toBeVisible();
  await tour.getByRole('button', { name: 'Skip tour' }).click();
  await expect(tour).toBeHidden();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Spikes & clips' })).toBeVisible();
  await expect(tour).toBeHidden();
  // ...and "Take the tour" opens it again whenever you want.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Take the tour' }).click();
  await expect(tour).toContainText('Welcome to Spikecut');
  await page.keyboard.press('Escape');
  await expect(tour).toBeHidden();
  await open(page, 'dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('No data yet')).toBeVisible();

  // Folders: add through the (stubbed) folder dialog, then scan.
  await open(page, 'folders');
  await page.getByRole('button', { name: 'Add folder' }).click();
  await expect(page.getByTestId('folder-name')).toHaveText(path.basename(videosDir));
  await page.getByRole('button', { name: 'Scan now' }).click();
  await expect(page.getByTestId('scan-result')).toContainText('Found 1', { timeout: 30_000 });

  // Upload a clip JSON through the UI: its text is applied to the matching video.
  const clipJson = { stream: { name: 'Test stream' }, clips: [{ file: 'my clip.mp4', post_title: 'Imported from JSON', description: 'Imported description', hashtags: ['#openworld', '#shorts'], hook_text: 'Hook', reason: 'spike' }] };
  await page.getByLabel('Clip JSON file').setInputFiles({ name: 'clips.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(clipJson)) });
  await expect(page.getByTestId('scan-result')).toContainText('clips.json: 1 updated');

  // Library: the video is listed with its duration, and its title came from the JSON.
  await nav(page, 'Review & publish');
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
  await open(page, 'dashboard');
  await expect(page.getByTestId('count-detected')).toHaveText('1');
  await expect(page.getByTestId('count-metadataReady')).toHaveText('1');

  // Settings: the Gemini key is write-only and never shown back.
  await nav(page, 'Settings');
  // Appearance: a pastel theme applies at once and is remembered after a reload.
  await page.getByRole('radio', { name: /Sage/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'sage');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'sage');
  await expect(page.getByRole('radio', { name: /Sage/ })).toHaveAttribute('aria-checked', 'true');
  await page.getByText('Advanced: Gemini').click();
  await page.getByLabel('Gemini API key').fill('SECRET-KEY-VALUE-123');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByRole('status')).toContainText('API key saved');
  await page.reload();
  await page.getByText('Advanced: Gemini').click();
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

test('the YouTube account page walks you through making a Google OAuth client', async ({ page }) => {
  await page.goto(url);
  const tour = page.getByRole('dialog', { name: 'Spikecut tour' });
  if (await tour.isVisible()) await page.keyboard.press('Escape');
  await open(page, 'accounts');

  // No client saved yet: the guide is open, on step 1, with its screenshot loaded.
  const guide = page.getByRole('region', { name: 'How to get a client ID' });
  await expect(guide).toBeVisible();
  await expect(guide).toContainText('Step 1 of');
  await expect(guide.getByRole('heading', { level: 3 })).toHaveText('Create a Google Cloud project');
  const shot = guide.getByRole('img');
  await expect.poll(() => shot.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);

  // Next / Back move through the steps; the last step says where the two values go.
  await guide.getByRole('button', { name: 'Next' }).click();
  await expect(guide).toContainText('Step 2 of');
  await guide.getByRole('button', { name: 'Back' }).click();
  await expect(guide).toContainText('Step 1 of');
  await guide.getByRole('button', { name: /^Copy the client ID/ }).click();
  await expect(guide.getByRole('heading', { level: 3 })).toHaveText('Copy the client ID and secret into Spikecut');
  await expect(guide.getByRole('button', { name: 'Next' })).toBeDisabled();
  await expect.poll(() => guide.getByRole('img').evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);

  // It can be folded away.
  await page.getByRole('button', { name: 'Hide guide' }).click();
  await expect(guide).toBeHidden();
});
