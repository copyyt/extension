# Copyyt Chrome extension

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
`assets/offscreen.js`; `manifest.extension.json` registers the former as a
module service worker. Runtime session/status records live in
`chrome.storage.local`. Processed and outbound item metadata live in the
`copyyt-runtime-v1` IndexedDB database and contain no plaintext. Processed
items are retained for at most 24 hours and 500 records.

For the first device, use the explicit **Trust this device (first setup)**
action in the popup. A server-reported `trusted` label remains locally
`unverified`; it never bootstraps a root. Phase 2A uses manual **Send current
clipboard** and does not install clipboard polling or `clipboardchange`
listeners.

## Development

```bash
yarn build
yarn lint
yarn test:crypto
yarn test:runtime
yarn test:chrome
```

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
