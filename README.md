# Copyyt Chrome extension

The extension shares the Android [Copyyt color palette](docs/color-palette.md): Warm Paper in light mode and Harbor Dark in dark mode.

## Product status

- Copyyt Chrome extension: active primary client.
- Copyyt Web/PWA: paused. Its source is retained for possible future
  dashboard/manual-client work.
- Copyyt marketing/privacy website: active.

The retained web client is selected with `VITE_APP_TYPE=web`. Production and
manual PWA deployments explicitly set `VITE_WEB_APP_PAUSED=true`, which serves
an inert paused page instead of mounting the legacy clipboard/account client.
For intentional local work on that retained client, use
`VITE_APP_TYPE=web VITE_WEB_APP_PAUSED=false`.

The PWA build keeps VitePWA's normal `autoUpdate` service-worker behavior.
After the paused build is manually deployed once, existing installations can
receive the paused shell through the normal service-worker update flow. Future
Chrome extension releases do not deploy the PWA because the server workflow is
manual-only.

The extension’s Phase 1D crypto core is framework-independent and uses Chrome
137+ WebCrypto primitives: Ed25519 device signatures, X25519 key agreement,
HKDF-SHA-256, and AES-256-GCM. Plaintext clipboard contents and private keys
are not sent to the backend.

Device private keys are generated once per Copyyt account and persisted as
non-extractable `CryptoKey` objects in account-scoped IndexedDB records. Use
`getDeviceIdentity(userId)`, `getOrCreateDeviceIdentity(userId)`, and
`clearDeviceIdentity(userId)`; identities are never shared across accounts.
Only raw 32-byte public keys, encoded as canonical padded standard Base64, are
used in device registration and protocol messages. Production trust state is
persisted by `IndexedDBTrustStore`; call `bootstrapInitialTrustAnchor(...)`
explicitly for the first-device ceremony. Server registration labels never
establish local cryptographic trust.

Phase 2A adds the MV3 runtime around that core. The service worker owns the
session, device registration, durable trust reads, Socket.IO connection,
challenge signing, encryption/decryption, deduplication, and popup status.
The offscreen document is only a `CLIPBOARD`-reason adapter for
`READ_TEXT`, `WRITE_TEXT`, and `PING` messages. The popup does not own a socket
or return clipboard text through runtime messages.

The extension build emits `assets/service-worker.js` and
`assets/offscreen.js`; the explicit `manifest.extension.dev.json` and
`manifest.extension.store.json` variants register the former as a module
service worker. Runtime session/status records live in
`chrome.storage.local`. Processed and outbound item metadata live in the
`copyyt-runtime-v1` IndexedDB database and contain no plaintext. Processed
items are retained for at most 24 hours and 500 records.

For the first device, the popup offers **Trust this device (first setup)**
only after a fresh backend eligibility check proves that this is the account's
only trusted device, its full identity matches, and no local root exists. The
runtime repeats that check when the command is invoked, so a later registered
device cannot take the self-root path. A server-reported `trusted` label
remains locally `unverified`; it never establishes local cryptographic trust.
This is still a TOFU bootstrap: a malicious backend could lie during the very
first bootstrap, which is an accepted limitation of this phase.

Later devices use the manual pairing ceremony. Both devices display the same
full-key `copyyt-pairing-fingerprint-v1`; the existing locally trusted device
signs the pending device's `copyyt-device-approval-v1` certificate, and the
new device pins the approver only after the user confirms the matching
fingerprint. Server trust labels alone never complete pairing. Access-token
renewal is owned by the service worker and uses a single-flight refresh before
recreating an authenticated socket when needed.

Clipboard Sync supports automatic text detection when sending is enabled, as
well as manual **Send current clipboard**. It does not synchronize images or
files and does not provide clipboard history.

## Development

```bash
yarn build
yarn build:extension
yarn build:store
yarn lint
yarn test:palette
yarn test:crypto
yarn test:runtime
yarn test:chrome
```

`yarn build:extension` keeps the development host permissions and writes to
`build-extension/`. `yarn build:store` uses only the production API host,
validates the Store manifest as version 2.0.1, audits the source and artifact
for MV3 remote-code violations, and writes the uploadable directory to
`build-extension-store/`.

`yarn test:chrome` first runs the existing local Vite harness for cross-realm
identity creation and real IndexedDB `CryptoKey` persistence, then builds the
extension and launches a separate Chrome instance against
`runtime-harness.html`. The second harness asks the service worker to create
the offscreen document and exercises the real OS clipboard adapter without
returning clipboard contents in its result.
Set `CHROME_BIN` when Chrome is not installed in a standard location.

To test Chrome with its UI enabled, set `COPYYT_CHROME_HEADLESS=0`. Some
managed or already-running Chrome installations refuse command-line unpacked
extension loading; the harness reports that browser limitation instead of
adding a runtime workaround.

## Template notes

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/README.md) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type aware lint rules:

- Configure the top-level `parserOptions` property like this:

```js
export default tseslint.config({
  languageOptions: {
    // other options...
    parserOptions: {
      project: ['./tsconfig.node.json', './tsconfig.app.json'],
      tsconfigRootDir: import.meta.dirname,
    },
  },
})
```

- Replace `tseslint.configs.recommended` to `tseslint.configs.recommendedTypeChecked` or `tseslint.configs.strictTypeChecked`
- Optionally add `...tseslint.configs.stylisticTypeChecked`
- Install [eslint-plugin-react](https://github.com/jsx-eslint/eslint-plugin-react) and update the config:

```js
// eslint.config.js
import react from 'eslint-plugin-react'

export default tseslint.config({
  // Set the react version
  settings: { react: { version: '18.3' } },
  plugins: {
    // Add the react plugin
    react,
  },
  rules: {
    // other rules...
    // Enable its recommended rules
    ...react.configs.recommended.rules,
    ...react.configs['jsx-runtime'].rules,
  },
})
```
