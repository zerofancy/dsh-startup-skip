import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { checkCompatibility } from '../compatibility.js';

const entry = resolve('fixture/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js');
const packageDir = dirname(dirname(entry));
const desktop = resolve(packageDir, '../../../../lib/main.js');
const fixture = `
function needsWelcome(authentication) {
 return !authentication.loggedIn && !authentication.hasApiKey;
}
hasApiKey: Object.values(states).some((value) => record$3(value) && value.configured === true)
analyticsEnabled = await welcomeBackend.analyticsEnabled().catch(() => false);
namespace: "productAnalytics", method: "enabled"
await backend.start(async () => { await Promise.all([]); });
if (backend.host !== void 0) await openInitialWindow();
ipcMain.handle(DESKTOP_IPC.boot, async (event) => { assertDesktopSender(event, ["app"]); await startup;
`;
function options(source = fixture, version = '0.2.1-rc.2') {
  return { entry, connected: true, async readText(path) {
    if (path === resolve(packageDir, 'package.json')) return JSON.stringify({ name: '@deepseek-ai/dsh-desktop-host', version });
    assert.equal(path, desktop);
    return source;
  } };
}

test('compatible manifest and ABI fingerprints permit the known desktop host', async () => {
  assert.deepEqual(await checkCompatibility(options()), { ok: true, reason: 'compatible' });
});
test('ordinary Node, CLI and Web processes never read files or intercept', async () => {
  const readText = () => { throw new Error('must not read'); };
  assert.equal((await checkCompatibility({ entry, connected: false, readText })).reason, 'not-desktop-host');
  assert.equal((await checkCompatibility({ entry: resolve('index.js'), connected: true, readText })).reason, 'not-desktop-host');
  assert.equal((await checkCompatibility({ entry: entry.replace('index.js', 'cli.js'), connected: true, readText })).reason, 'not-desktop-host');
});
test('new versions, changed protocols and missing files preserve official behavior', async () => {
  assert.equal((await checkCompatibility(options(fixture, '0.2.1-rc.3'))).reason, 'unsupported-runtime-version');
  assert.equal((await checkCompatibility(options(fixture.replace('Object.values(states)', 'Object.values(other)')))).reason, 'unsupported-desktop-protocol');
  assert.equal((await checkCompatibility({ entry, connected: true, readText: async () => { throw new Error('missing'); } })).reason, 'compatibility-check-unavailable');
});
