// Offline unit tests for the pure front-end logic. Run with `deno task test`.
// They live outside src/ so the app's tsc/vite build never sees them.
import assert from 'node:assert/strict';
import { toWebampTrack } from '../src/addsource.ts';
import { frameSize, getFrameWidth, setFrameWidth, VIDEO_STACK_FLOOR } from '../src/videowindow.ts';
import { defaultOutputName, realOutputs } from '../src/output.ts';

const track = {
  video_id: 'abcdefghijk',
  title: 'Song',
  channel: 'Artist',
  duration_s: 215,
  stream_url: 'http://127.0.0.1:1234/v/abcdefghijk',
};

Deno.test('toWebampTrack maps fields and always sets a duration', () => {
  const t = toWebampTrack(track);
  assert.deepEqual(t, {
    metaData: { artist: 'Artist', title: 'Song' },
    url: track.stream_url,
    duration: 215,
  });
});

Deno.test('toWebampTrack uses an empty artist when the channel is unknown', () => {
  assert.equal(toWebampTrack({ ...track, channel: null }).metaData.artist, '');
});

Deno.test('setFrameWidth clamps to the allowed range and rounds', () => {
  setFrameWidth(10);
  assert.equal(getFrameWidth(), 220);
  setFrameWidth(5000);
  assert.equal(getFrameWidth(), 900);
  setFrameWidth(300.6);
  assert.equal(getFrameWidth(), 301);
});

Deno.test('frameSize is as tall as the stack, with a minimum height', () => {
  setFrameWidth(400);
  assert.deepEqual(frameSize(500), { w: 400, h: 500 });
  assert.equal(frameSize(10).h, 116);
});

Deno.test('the stack floor leaves room for a full 16:9 picture plus chrome', () => {
  assert.equal(VIDEO_STACK_FLOOR, 20 + 14 + 252);
});

const devices = [
  { kind: 'audioinput', deviceId: 'mic1', label: 'Microphone' },
  { kind: 'audiooutput', deviceId: 'default', label: 'Default - Krisp Speaker (Krisp Audio)' },
  { kind: 'audiooutput', deviceId: 'communications', label: 'Communications - Krisp Speaker (Krisp Audio)' },
  { kind: 'audiooutput', deviceId: 'abc', label: 'Speakers (Realtek(R) Audio)' },
  { kind: 'audiooutput', deviceId: 'def', label: 'Krisp Speaker (Krisp Audio)' },
] as MediaDeviceInfo[];

Deno.test('realOutputs keeps real output devices, not the default/communications aliases', () => {
  assert.deepEqual(realOutputs(devices), [
    { id: 'abc', label: 'Speakers (Realtek(R) Audio)' },
    { id: 'def', label: 'Krisp Speaker (Krisp Audio)' },
  ]);
});

Deno.test('realOutputs is empty when names are hidden (no permission)', () => {
  assert.deepEqual(realOutputs([{ kind: 'audiooutput', deviceId: '', label: '' }] as MediaDeviceInfo[]), []);
});

Deno.test('defaultOutputName reads the system default from its alias', () => {
  assert.equal(defaultOutputName(devices), 'Krisp Speaker (Krisp Audio)');
  assert.equal(defaultOutputName([]), '');
});
