# DSH Startup Skip

<img src="icon.svg" width="72" height="72" alt="Enter the workspace" />

[简体中文](README.md) | **English**

An unofficial Host plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Desktop. If you already access models through a third-party plugin, it attempts to skip the extra DeepSeek sign-in / API-key welcome screen on each cold start.

No application patching and no placeholder API key.

> **This is a version-specific compatibility workaround, not a model authentication tool.** It deliberately returns synthetic `configured: true` metadata for one startup check. That marker is not an API key or proof of an authorized model. It does not provide accounts, models or credits, and does not bypass provider authentication, billing or access limits.

## Compatibility

| Item | Scope |
| --- | --- |
| Plugin version | `0.1.0` |
| DSH Desktop | **Exactly `0.2.1-rc.2`**, with additional startup-code checks |
| Package | Host-only bundle; no third-party runtime dependencies, build or installation scripts |
| Prerequisite | An existing model access method, such as an independently authorized ChatGPT-plan plugin |
| Web / CLI | Not adapted; stock behavior is retained |
| License | [MIT](LICENSE), including the original SVG icon |

Not affiliated with or endorsed by DeepSeek or OpenAI. It does not depend on a particular third-party plugin's private account format.

## Why?

The targeted Desktop startup check recognizes a stored DeepSeek account credential or a configured model API key. A third-party plugin's own OAuth authorization may not satisfy that check, even when the plugin can already serve models.

This plugin expresses an explicit local preference: **let me enter the workspace without configuring those two authentication paths; keep model access with my existing provider.**

## Installation

### DSH plugin management

Ask DSH to install and enable this GitHub bundle, and approve the installation:

```text
github:zerofancy/dsh-startup-skip
```

This is a GitHub source installation, not an npm package name. The manifest retains `@local/dsh-startup-skip`; `private: true` prevents accidental npm publication, not GitHub installation.

### Terminal

If the Desktop-managed `dsh` command is already available, fully quit the application and run:

```sh
dsh plugin --profile desktop add github:zerofancy/dsh-startup-skip
```

GitHub and any package registry required by DSH installation must be reachable. If `dsh` is unavailable, use plugin management rather than installing a second, potentially different DSH version.

### Local checkout

```sh
git clone https://github.com/zerofancy/dsh-startup-skip.git
```

Install the checkout's **absolute directory path** through DSH plugin management. Directory installations may link the checkout, so do not move or delete it afterwards.

## Usage

1. Confirm **Skip Startup Sign-in** is enabled in your `desktop` profile.
2. **Fully quit** DSH using the application menu or system tray. Closing a window may only hide it.
3. Restart and check whether the workspace opens directly.
4. Keep or manually choose your existing model. Its own authorization, network and quota rules still apply.

The plugin never restarts the application itself. A hot installation does not replay the current window's startup decision. Hot reload or disabling/re-enabling it is not a fresh cold start.

## How it works

The public `connection/request` hook runs after DSH has admitted and authenticated the HTTP request. The plugin recognizes this serial startup sequence with matching request characteristics:

```text
productAnalytics/enabled
  → settings/describe
  → llm/listConfigurableProviders
  → credentials/describe
```

The first three successful responses are validated and forwarded unchanged. If the final successful metadata response has no real `configured: true` entry, the plugin appends its own clearly named, transient policy marker. The targeted native welcome check uses `Object.values(...).some(configured)` and therefore permits workspace entry.

The plugin then stops adapting responses for the rest of that Host process. **Later credential queries return real data.** If a genuine configured credential already exists, no marker is added.

One-shot behavior matters: later onboarding also checks API-key presence. A persistent false positive could trigger automatic display/Coding Tools preferences. This implementation does not replace the global Credentials service, register a fake provider, or change direct in-process Host credential reads.

## Data and security boundaries

- No fake key is saved. No account/credential files or third-party token stores are read. Compatibility checks read only the application's package version and startup code.
- The hook transiently inspects target settings/provider/credential metadata responses. It hashes the request Cookie and User-Agent with SHA-256 to correlate candidates in memory. The digest is not persisted; logs contain fixed classifications, not headers, payloads, credential refs or tokens.
- HTTP authentication, Host/Origin validation and update checks remain intact. Requests must first be admitted by DSH's own connection layer.
- `productAnalytics/enabled` is observed only as a sequence feature. The plugin does not change analytics preferences or issue additional analytics calls.
- Missing Origin/Referer, loopback addresses and a matching digest are **heuristics, not an exclusive native-welcome identity**. Another authenticated local client could theoretically produce the same sequence.
- Only selected ordinary JSON responses are buffered, up to **256 KiB** each. Subsequent candidate requests must enter within **30 seconds** of the first stage. The deadline is checked at request entry, not at response completion. Unexpected structures, failures, compression, size overflow, ambiguous concurrency or interruptions stop adaptation and retain the original response/error behavior.

## Limitations

1. Only `0.2.1-rc.2` is supported. Package version and startup-code fingerprints must match; otherwise stock behavior is retained. **Do not force unknown versions through an exemption.**
2. Compatibility includes query ordering, RPC framing, response writing and credential aggregation—not just the welcome predicate itself.
3. At least one model credential ref must be queried. Without a `credentials/describe` request, there is nothing to adapt.
4. Cold start only: account expiration, explicit sign-out, recovery and arbitrary Host-only restarts may still show welcome screens.
5. It does not check whether third-party OAuth is usable, choose a model, grant tool permissions or grant provider access.
6. The HTTP hook is public; the extra-marker behavior and native welcome protocol are version-specific implementation details, not an officially supported skip-login API.

## Verification status

- **53 automated tests passed** in the development environment, covering a real Node HTTP bridge simulation, concurrency, one-shot rewriting, UTF-8 chunks, framing, disconnects, unload and exceptional cleanup.
- Local installation in the target Desktop profile returned `application: applied`, and the runtime entry was confirmed.
- **No manual full-quit/cold-start acceptance result had been confirmed at publication time.** Tests and successful installation do not establish Desktop end-to-end success. Full Windows/macOS validation is not claimed.

Useful manual checks: two consecutive cold starts, normal conversation with the existing model, unchanged display/Coding Tools preferences, and restoration of stock behavior after disabling and restarting.

## Disable / remove

Disable **Skip Startup Sign-in** in plugin management and fully restart DSH. Alternatively remove the `@local/dsh-startup-skip` bundle through plugin management.

No placeholder credential needs cleanup and no model authorization needs revocation. Disabling does not close an already open workspace.

## Troubleshooting

| Symptom / classification | Meaning |
| --- | --- |
| Welcome still appears | Check full exit, profile, enablement and the exact supported DSH version |
| `unsupported-runtime-version` / `unsupported-desktop-protocol` | Compatibility protection retained stock behavior; wait for an adaptation |
| `ambiguous-startup-sequence` / `startup-window-expired` | This round was conservatively stopped; check startup delay or plugin interactions |
| `not-desktop-host` / `compatibility-check-unavailable` | Startup mode or application layout could not be matched |
| Workspace opens but the model fails | Check the existing model plugin's authorization, quota and network |

Issues should include DSH/plugin version, OS, reproduction steps and fixed diagnostic classifications. **Never upload account files, Cookies, tokens, complete request/response bodies or unsanitized logs.**

## Development

Node.js 24+ is recommended. No dependency installation, internet access or real account is needed:

```sh
npm test
```

Equivalent:

```sh
node --test --test-isolation=none test/*.test.js
```

Subprocess isolation is disabled for Windows sandboxes that cannot open named pipes. Some tests still require binding a local loopback port.

| File | Responsibility |
| --- | --- |
| [index.js](index.js) | Host lifecycle, process-level state and hook registration |
| [compatibility.js](compatibility.js) | Read-only package and startup-code checks |
| [core.js](core.js) | Startup state machine and bounded response adaptation |
| [cordis.patch.yml](cordis.patch.yml) | Bundle mount declaration |
| [test/](test/) | HTTP integration and exceptional-path regression tests |

GitHub/local distribution only; no npm publication. Compatibility changes should include the exact DSH version and regression evidence, not merely a widened version range.

## License

[MIT License](LICENSE) · Copyright © 2026 zerofancy and contributors.

The code and original SVG icon are provided under MIT. Product names identify compatibility targets and do not imply endorsement.
