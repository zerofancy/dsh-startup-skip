import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

export const SUPPORTED_VERSION = '0.2.1-rc.2';

// Read code/manifest only, never user configuration, accounts or credentials.
export async function checkCompatibility({ entry = process.argv[1], connected = process.connected,
  readText = path => readFile(path, 'utf8') } = {}) {
  if (!connected || !entry || basename(entry) !== 'index.js') return { ok: false, reason: 'not-desktop-host' };
  const packageDir = dirname(dirname(resolve(entry)));
  if (basename(packageDir) !== 'dsh-desktop-host' || basename(dirname(packageDir)) !== '@deepseek-ai') {
    return { ok: false, reason: 'not-desktop-host' };
  }
  try {
    const manifest = JSON.parse(await readText(resolve(packageDir, 'package.json')));
    if (manifest.name !== '@deepseek-ai/dsh-desktop-host' || manifest.version !== SUPPORTED_VERSION) {
      return { ok: false, reason: 'unsupported-runtime-version' };
    }
    const runtimeRoot = resolve(packageDir, '../../..');
    const source = await readText(resolve(runtimeRoot, '../lib/main.js'));
    // Deliberately conservative ABI fingerprints. They are supplementary guards,
    // not an assertion that arbitrary newer releases are compatible.
    const checks = [
      /function needsWelcome\(authentication\)\s*\{\s*return !authentication\.loggedIn && !authentication\.hasApiKey;/,
      /hasApiKey: Object\.values\(states\)\.some\(\(value\) => record\$3\(value\) && value\.configured === true\)/,
      /analyticsEnabled = await welcomeBackend\.analyticsEnabled\(\)\.catch\(\(\) => false\)/,
      /namespace: "productAnalytics",\s*method: "enabled"/,
      /await backend\.start\([\s\S]{0,220}await openInitialWindow\(\)/,
      /ipcMain\.handle\(DESKTOP_IPC\.boot,[\s\S]{0,200}await startup;/,
    ];
    if (!checks.every(pattern => pattern.test(source))) return { ok: false, reason: 'unsupported-desktop-protocol' };
    return { ok: true, reason: 'compatible' };
  } catch {
    return { ok: false, reason: 'compatibility-check-unavailable' };
  }
}
