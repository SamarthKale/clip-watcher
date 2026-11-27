import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseManifest } from '../../src/server/manifest/manifest.js';

// tests/fixtures/clips.schema2.json is written by Clip Watcher's own library step (clipwatcher/library.py).
// If either side changes the format, this test fails before an upload does.
describe('clips.json written by Clip Watcher (schema 2)', () => {
  const doc = JSON.parse(readFileSync(new URL('../fixtures/clips.schema2.json', import.meta.url), 'utf-8'));

  it('is accepted by the uploader manifest parser', () => {
    const clips = parseManifest(doc);
    expect(clips).toHaveLength(1);
    expect(clips[0].file).toMatch(/^01_.+\.mp4$/);
    expect(clips[0].title).toContain('Impossible Shot');
    expect(clips[0].description).toContain('https://www.twitch.tv/abc');
    expect(clips[0].hashtags).toEqual(['#shorts', '#abc', '#gaming']);
    expect(clips[0].context).toMatchObject({ stream: 'abc', kind: 'live' });
  });

  it('keeps Hinglish text and emoji intact', () => {
    expect(parseManifest(doc)[0].title).toContain('😭');
  });
});
