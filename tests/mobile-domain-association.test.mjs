import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

test('website association delegates link handling only to the Android package', async () => {
  const statements = JSON.parse(await read('public/.well-known/assetlinks.json'));
  const config = await read('apps/mobile/capacitor.config.ts');
  const gradle = await read('apps/mobile/android/app/build.gradle');
  const packageName = /appId:\s*"([^"]+)"/.exec(config)?.[1];
  assert.ok(packageName);
  assert.equal(/applicationId\s+"([^"]+)"/.exec(gradle)?.[1], packageName);
  assert.equal(statements.length, 1);
  const statement = statements[0];
  assert.deepEqual(Object.keys(statement).sort(), ['relation', 'target']);
  assert.deepEqual(statement.relation, ['delegate_permission/common.handle_all_urls']);
  assert.equal(statement.target.namespace, 'android_app');
  assert.equal(statement.target.package_name, packageName);
  const fingerprints = statement.target.sha256_cert_fingerprints;
  assert.ok(Array.isArray(fingerprints) && fingerprints.length > 0);
  assert.equal(new Set(fingerprints).size, fingerprints.length);
  for (const fingerprint of fingerprints) assert.match(fingerprint, /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});

test('Android HTTPS link enrollment stays scoped to the mobile auth callback', async () => {
  const manifest = await read('apps/mobile/android/app/src/main/AndroidManifest.xml');
  const filters = [...manifest.matchAll(/<intent-filter\b[^>]*>([\s\S]*?)<\/intent-filter>/g)]
    .filter(filter => /android:scheme="https"/.test(filter[1]));
  assert.equal(filters.length, 1);
  const enrolled = [...filters[0][1].matchAll(/<data\s+([^>]+)\/>/g)];
  assert.equal(enrolled.length, 1);
  assert.match(enrolled[0][1], /android:scheme="https"/);
  assert.match(enrolled[0][1], /android:host="tomverse\.app"/);
  assert.match(enrolled[0][1], /android:path="\/auth\/mobile\/callback"/);
  assert.doesNotMatch(enrolled[0][1], /android:pathPrefix|android:pathPattern/);
});
