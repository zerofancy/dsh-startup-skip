import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
test('bundle exports runtime, localized metadata and an original bounded SVG', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(manifest.engines.dsh, '0.2.1-rc.2');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.scripts.preinstall, undefined);
  for (const file of ['index.js', 'core.js', 'compatibility.js', 'cordis.patch.yml', 'README.md', 'LICENSE', 'icon.svg']) {
    assert.ok(manifest.files.includes(file));
    assert.ok((await stat(new URL(file, root))).isFile());
  }
  for (const language of ['en', 'zh']) {
    const locale = JSON.parse(await readFile(new URL(`locale/${language}.json`, root), 'utf8'));
    assert.ok(locale.meta.title.length > 4);
    assert.ok(locale.meta.description.includes('0.2.1-rc.2'));
  }
  const icon = await readFile(new URL('icon.svg', root), 'utf8');
  assert.ok(Buffer.byteLength(icon) < 262144);
  assert.match(icon, /<svg[^>]+xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.doesNotMatch(icon, /<script|<image|href=/i);
  const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8');
  assert.match(patch, /id: local-startup-skip/);
  assert.ok(patch.includes("name: '@local/dsh-startup-skip'"));
});
