import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function isolatedTestBase(value, allowLive = false) {
  const base = new URL(value || 'https://localhost:18854');
  assert(['http:', 'https:'].includes(base.protocol), 'Only HTTP(S) is supported');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Test API must be on loopback');
  assert(Number(base.port) >= 18000 || allowLive, 'Use an isolated high-port test API');
  assert(!base.username && !base.password, 'Test URL cannot contain credentials');
  return base;
}

export async function trustedTestCa(base) {
  if (base.protocol !== 'https:') return undefined;
  const certPath = process.env.AMUX_IOS_TEST_CA || path.join(os.homedir(), '.amux', 'tls', 'cert.pem');
  return readFile(certPath);
}

export function localRequestOptions(url, base, options = {}) {
  const endpoint = new URL(url, base);
  assert.equal(endpoint.origin, base.origin, 'Test requests cannot leave the selected API origin');
  assert(!endpoint.username && !endpoint.password, 'Test requests cannot contain credentials');
  return {
    ...options,
    hostname: base.hostname === '[::1]' ? '::1' : '127.0.0.1',
    port: Number(base.port),
    servername: 'localhost',
    path: endpoint.pathname + endpoint.search,
  };
}
