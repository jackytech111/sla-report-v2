import { test } from 'node:test';
import assert from 'node:assert/strict';

test('type stripping is available', () => {
  assert.equal(typeof process.features.typescript, 'string');
});
