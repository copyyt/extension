# Copyyt Chrome extension

> **Project status:** Copyyt is transitioning to open source and maintenance-only development. It was built as an end-to-end encrypted cross-device clipboard solution and remains available to use, study, and contribute to. Critical and security fixes may still be considered; new feature development is not currently planned.

Copyyt is a Chrome/Chromium Manifest V3 extension that syncs clipboard content between devices signed in to the same Copyyt account and paired as trusted devices. It supports plain text, formatted text with a plain-text fallback, and PNG images. It does not sync arbitrary files or keep a clipboard history. The extension uses the Android [Copyyt color palette](docs/color-palette.md): Warm Paper in light mode and Harbor Dark in dark mode.

## What it does

- Watches for clipboard changes when sending is enabled, or sends the current clipboard on request. Each device can use **Send & receive**, **Send only**, **Receive only**, or **Paused** mode.
- Encrypts clipboard items for trusted recipient devices. Text and supported formatted text arrive on the receiving clipboard automatically. Received images are kept encrypted locally until the user opens the popup and clicks **Copy image** to write one to the clipboard.
- Sends short-lived encrypted items through the Copyyt Socket.IO relay. For eligible recipients, an oversized PNG may use an encrypted WebRTC data channel on a reachable local network. The Copyyt socket still carries connection signalling, and a compatible text fallback can use the relay if direct delivery fails.
- Supports passwordless email-code and Google sign-in, first-device trust setup, fingerprint-confirmed pairing of later devices, and device management.

Image and direct-transfer availability also depend on the account plan and the receiving device's advertised capabilities.

## Architecture

```text
Device A: OS clipboard
    -> offscreen clipboard adapter
    -> MV3 service worker: select recipients, encrypt, sign
    -> Socket.IO relay: encrypted envelope
       or WebRTC data channel: encrypted chunks (when eligible and reachable)
    -> Device B service worker: verify, decrypt
    -> offscreen adapter: text/HTML clipboard write
       or popup: user clicks Copy image for PNG
```

The popup manages sign-in, pairing, preferences, status, and the assisted image-copy action. The service worker owns the session, device registration, trust checks, Socket.IO connection, cryptography, deduplication, and delivery policy. The offscreen document provides clipboard access and the WebRTC peer connection because the service worker cannot use those DOM APIs directly. The retained web/PWA client is separate from this extension workflow; production and manual PWA builds use a paused shell (see [Development](#development)).

## Privacy and security

- Clipboard payloads are encrypted in the sending extension before relay publication or direct transfer and decrypted in the receiving extension after source-trust, signature, and expiry checks. The service worker uses Ed25519 device signatures, X25519 key agreement, HKDF-SHA-256, and AES-256-GCM. Direct-transfer chunks have their own encrypted, authenticated package.
- Device private signing and encryption keys are generated as non-extractable WebCrypto keys and stored in account-scoped IndexedDB records. Only their raw 32-byte public keys, encoded as canonical padded Base64, are used for registration and protocol messages. Access and refresh tokens for the signed-in extension session are stored in `chrome.storage.local`; the runtime requests trusted-context-only access where Chrome supports it.
- First-device setup explicitly establishes a local trust root after checking backend eligibility. This is trust on first use: a malicious backend could misrepresent the account's device state during that initial ceremony. Later devices require a matching displayed fingerprint and a signed approval from a locally trusted device. A backend `trusted` label alone does not establish local cryptographic trust.
- Relay messages contain ciphertext plus routing and protocol metadata. The backend necessarily sees account/device identifiers, public keys, item IDs, content type, ciphertext size, timestamps/expiry, connection status, and WebRTC signalling (including ICE candidates for direct connections). It does not receive clipboard plaintext or device private keys from this client. The extension assigns live clipboard items a 60-second expiry and rejects stale items; **the backend source is not in this repository**, so its actual queueing, storage, deletion, and logging behavior cannot be verified here.
- Locally, `copyyt-runtime-v1` IndexedDB keeps processed/outbound item metadata for deduplication, pruned to at most 24 hours and 500 records. Pending received images are stored as encrypted envelopes or direct-transfer packages until copied or expired. The implementation has no user-facing clipboard history. The OS clipboard, sending/receiving extension contexts, and the receiving device after decryption can access plaintext.

These protections depend on the integrity of the paired devices and their browser environments. The direct path uses WebRTC with no configured STUN/TURN servers (`iceServers: []`), so it requires a reachable peer connection; it is not a general cross-network direct-transfer guarantee.

The reusable crypto core exposes `getDeviceIdentity(userId)`, `getOrCreateDeviceIdentity(userId)`, and `clearDeviceIdentity(userId)` for account-scoped identities. `IndexedDBTrustStore` persists local trust, and `bootstrapInitialTrustAnchor(...)` starts the explicit first-device ceremony. Runtime session and status records live in `chrome.storage.local`; the extension build emits module `assets/service-worker.js` and `assets/offscreen.js` entries.

## Getting started

1. Use Chrome/Chromium **137 or newer**. Build the extension as described below.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `build-extension/`.
3. Open the Copyyt popup and sign in with an email code or Google. Set up trust on the first device. On another installation, sign in to the same account and confirm the matching pairing fingerprint on both devices.
4. Choose a sync mode on each device. Copy text or an image on one device. Text can be pasted normally on a receiving device; for an incoming image, open the popup and click **Copy image** before pasting.

The extension requires a compatible Copyyt backend for authentication, device registration, relay delivery, and WebRTC signalling. This repository contains the browser client, not that backend. A local build alone cannot provide cross-device sync.

## Development

Prerequisites: Node.js with the `--experimental-strip-types` flag for the test scripts (Node 22.6+), Yarn 4.1.1 via Corepack, and Chrome/Chromium 137+ for loading and browser tests. Install dependencies with `corepack yarn install`.

For a development extension, create a local `.env` with endpoints for a **compatible** backend, for example:

```dotenv
VITE_APP_TYPE=extension
VITE_API_URL=http://localhost:8000
VITE_SOCKET_URL=http://localhost:8000
```

`VITE_API_URL` is the REST base URL (the client appends `/api/v1`); `VITE_SOCKET_URL` is the Socket.IO origin. The dev manifest permits `localhost` and `127.0.0.1` on ports 8000 and 8001, plus the configured production host. If your backend uses another origin, adjust the dev manifest's host permissions for local use. This repository does not include backend setup or backend environment variables. Do not place real credentials in `.env` or documentation.

```bash
corepack yarn build:extension  # development extension -> build-extension/
corepack yarn build:store      # Chrome Web Store artifact -> build-extension-store/
corepack yarn lint
corepack yarn test:crypto
corepack yarn test:clipboard
corepack yarn test:runtime
corepack yarn test:direct
```

`build:store` pins REST and Socket.IO to `https://api.copyyt.com`, validates the Store manifest, and audits the bundle for MV3 remote-code restrictions. Its host permissions contain only that production API origin. `yarn build` is the underlying TypeScript/Vite/worker build; `yarn dev` starts Vite for UI development and is not the unpacked extension build.

Other scripts include `test:auth`, `test:palette`, and `test:chrome`. The Chrome script first runs a local browser harness for cross-realm identity creation and IndexedDB `CryptoKey` persistence, then builds and loads an unpacked extension to exercise the real offscreen clipboard adapter without returning clipboard contents in its result. Set `CHROME_BIN` if Chrome is in a nonstandard location, or `COPYYT_CHROME_HEADLESS=0` to see its UI. Some managed or already-running Chrome installations refuse command-line unpacked-extension loading.

The retained web client is selected with `VITE_APP_TYPE=web`. Its production/manual PWA deployment sets `VITE_WEB_APP_PAUSED=true` to show an inert paused page; intentional local work on the legacy client can use `VITE_APP_TYPE=web VITE_WEB_APP_PAUSED=false`. `VITE_GOOGLE_CLIENT_ID_WEB` applies to that web Google sign-in flow. The PWA build keeps VitePWA's `autoUpdate` service-worker behavior; extension builds do not deploy the PWA.

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/crypto/` | Device identity, trust, pairing, envelope, and direct-transfer cryptography |
| `src/runtime/`, `src/service-worker.ts` | MV3 session, socket, delivery, status, and persistence |
| `src/clipboard/`, `src/offscreen.ts`, `src/direct/` | Clipboard formats, offscreen adapter, and WebRTC transport |
| `src/views/` | Extension popup and retained web views |
| `manifest.extension.*.json`, `vite.config.ts`, `scripts/` | Build targets, manifests, and validation |
| `docs/` | Palette and Chrome Web Store release notes |

## Looking for an actively developed alternative?

[UniClipboard](https://github.com/UniClipboard/UniClipboard) is an actively developed open-source cross-device clipboard project with native cross-platform apps and a broader feature set. I intend to explore contributing there instead of continuing a parallel implementation of the same core idea.

## Project history

Copyyt began as an attempt to make cross-device clipboard use secure and convenient. As projects such as UniClipboard have matured, development effort is shifting toward contributing to the wider open-source ecosystem while Copyyt remains available for maintenance, learning, and reuse.

## Contributing

Bug fixes, security fixes, and documentation improvements are welcome. Please discuss major new features in an issue first; this project is maintenance-focused. When reporting a security issue, avoid posting exploit details or secrets in a public issue.

## License

Copyyt is available under the [MIT License](LICENSE).
