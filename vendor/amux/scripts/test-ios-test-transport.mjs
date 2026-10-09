import assert from 'node:assert/strict';
import { isolatedTestBase, localRequestOptions } from './ios-test-transport.mjs';

const base = isolatedTestBase('https://localhost:18854');
assert.deepEqual(
  { hostname: localRequestOptions('/health', base).hostname, port: localRequestOptions('/health', base).port, path: localRequestOptions('/health', base).path },
  { hostname: '127.0.0.1', port: 18854, path: '/health' },
);
for (const bad of ['https://example.com/health', '//example.com/health', 'https://127.0.0.1:18855/health', 'https://user@localhost:18854/health']) {
  assert.throws(() => localRequestOptions(bad, base), undefined, bad);
}
for (const bad of ['https://example.com:18854', 'https://localhost:8824', 'file:///tmp/server']) {
  assert.throws(() => isolatedTestBase(bad), undefined, bad);
}
console.log('iOS test transport rejects off-origin requests');
