import assert from 'node:assert/strict';
import test from 'node:test';
import {decodeMultipartFilename} from './upload-filename.js';

test('multipart UTF-8 filenames are restored from Multer Latin-1 strings', () => {
  const original = '洗车店 2026-08-13 Trim (2).mp4';
  const multerValue = Buffer.from(original, 'utf8').toString('latin1');
  assert.equal(decodeMultipartFilename(multerValue), original);
});

test('valid filenames that are not UTF-8 byte sequences remain unchanged', () => {
  assert.equal(decodeMultipartFilename('résumé.mp4'), 'résumé.mp4');
  assert.equal(decodeMultipartFilename('clip-01.mp4'), 'clip-01.mp4');
});
