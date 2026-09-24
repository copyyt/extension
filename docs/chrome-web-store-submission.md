# Copyyt 2.0 Chrome Web Store submission notes

This document is for the Chrome Web Store submission and release handoff. The
Store artifact is produced by `yarn build:store` at
`build-extension-store/`; that command pins both REST and Socket.IO endpoints
to `https://api.copyyt.com` rather than inheriting development `.env`
values. It is an update to the existing Copyyt Web Store item and must keep
the existing extension key/identity.

## Single purpose

Copyyt securely synchronizes clipboard text between a user's trusted devices.

## Clipboard disclosure

When Clipboard Sync sending is enabled, Copyyt monitors clipboard text so that
a normal copy on one trusted device can become available for normal paste on
another. Clipboard text is encrypted on-device before transmission. The
extension explicitly supports background clipboard monitoring only while
sending is enabled; users can choose Both, Send only, Receive only, or Off.

Copyyt 2.0 synchronizes text only. It does not provide image, file, or
clipboard-history synchronization.

## Permission justifications

The Store manifest retains the six permissions used by the implementation:

| Permission | Justification |
| --- | --- |
| `clipboardRead` | Reads text from the operating-system clipboard in the packaged offscreen document when the user enables sending, including automatic send mode. |
| `clipboardWrite` | Writes a trusted, decrypted incoming text item to the operating-system clipboard so the user can paste it normally. |
| `offscreen` | Creates the packaged `offscreen.html` document with the `CLIPBOARD` reason because the MV3 service worker cannot directly use the DOM Clipboard API. |
| `storage` | Stores the signed-in session, authentication state, sync preferences, and runtime status in extension-owned `chrome.storage.local`. |
| `alarms` | Wakes the service worker for the connectivity-recovery alarm after sleep, resume, or a socket interruption; it is not a clipboard polling mechanism. |
| `identity` | Requests the Chrome-managed Google OAuth token used by the Google sign-in flow. |

The only Store host permission is:

`https://api.copyyt.com/*`

It is required for Copyyt's authenticated REST API and Socket.IO/WebSocket
connection used for account sign-in, device registration/pairing, encrypted
clipboard delivery, and connection status. The Store package contains no
localhost, loopback, or private-LAN host permissions.

## Data-use disclosure checklist

Use the following factual categories and purposes when completing the Chrome
Web Store data-use questionnaire. Confirm the dashboard's exact labels at the
time of submission rather than copying labels from this document.

- Clipboard text: read while sending is enabled; encrypted on-device and sent
  as encrypted clipboard envelopes for synchronization; written to the local
  clipboard when an authorized incoming item is received.
- Account information: account ID, email address, email-verification state,
  optional/display name, and the Google account identifier when Google login is
  used; used for authentication and account/device synchronization.
- Authentication credentials: access and refresh tokens may be stored in
  extension-owned local browser storage to keep the user signed in. They are
  used to authenticate the API and socket.
- Device and security metadata: device IDs, device names, platform, app
  version, capabilities, public encryption/signing keys, trust state,
  pairing/approval metadata, and connection/device status; used to register,
  identify, trust, revoke, and connect the user's devices.
- Local cryptographic material: private signing and encryption keys remain in
  the extension's local IndexedDB as non-extractable `CryptoKey` objects and
  are not sent to the backend.
- Local runtime metadata: processed/outbound item IDs and timestamps may be
  retained locally for deduplication and retry safety. This metadata contains
  no clipboard plaintext and is pruned after at most 24 hours or 500 records.
- No analytics category is claimed here: the extension has no implemented
  analytics collection described by this release documentation.

## Reviewer test instructions

1. Install the submitted extension and sign in to Copyyt using the review
   account supplied through the Web Store review channel, if one is required.
2. Install/sign in to Copyyt on a second trusted browser installation and
   complete the displayed device pairing/fingerprint confirmation.
3. Select **Both** on both devices.
4. Copy ordinary text on the first computer.
5. Paste normally on the second computer. The item should be available only as
   a short-lived encrypted live item.

Mode checks:

- **Send only**: clipboard changes on this device may be encrypted and sent;
  incoming items are not written to this device's clipboard.
- **Receive only**: this device does not monitor/send clipboard changes;
  authorized incoming text can be written to its clipboard.
- **Off**: this device neither monitors/sends nor applies incoming clipboard
  items. The authenticated connection may remain available for account and
  pairing status.

Do not put passwords, OTPs, private tokens, or other test secrets in this
repository. Provide any review credentials through the Web Store's supported
private review channel.

## Suggested listing copy

### Short description

Securely sync copied text across your trusted devices with end-to-end encryption.

### Long description

Copy on one device. Paste on another.

Copyyt automatically synchronizes copied text between your trusted computers
when Clipboard Sync is enabled. Clipboard payloads are encrypted on your
device before transmission and are delivered only to trusted Copyyt devices.

Choose the participation mode that fits the device:

- **Both** to send and receive clipboard text.
- **Send only** to send copied text without applying incoming items.
- **Receive only** to receive trusted text without monitoring local copies.
- **Off** to disable clipboard participation.

Copyyt 2.0 supports text synchronization only. Images, files, and clipboard
history are not currently supported. Background clipboard monitoring is used
when sending is enabled.

## MV3 and remote-code audit

`yarn build:store` runs TypeScript, produces a self-contained module service
worker, rejects `modulepreload`, and audits both source and final artifact for
`eval`, `new Function`, remote script tags, remote JavaScript resources, and
remote dynamic imports. The extension may call its production HTTPS API and
Socket.IO/WebSocket endpoint for data and authentication; those network calls
do not load executable extension code.

## Minimum Chrome version audit

Keep `minimum_chrome_version` at **137**.

The code uses MV3 service-worker/offscreen clipboard handling, runtime context
inspection, alarms, extension storage, and WebCrypto. Offscreen documents are
available from Chrome 109, and `runtime.getContexts()` is available from
Chrome 116, but Copyyt's device identity uses WebCrypto Ed25519 signing and
X25519 key agreement. Chrome added X25519 in Chrome 133 and Ed25519 in Chrome
137. Therefore 137 is technically justified by the current cryptographic
implementation; lowering it would require a different crypto implementation or
a verified compatibility fallback.

## Backend and release-safety checklist

- [ ] Verify the API/socket endpoint used by the submitted Store build is
      online and compatible before submitting for review.
- [ ] Do not deploy or substitute a fake/local/mock backend for Store review.
- [ ] Verify backend compatibility with existing public 1.2 users before
      production rollout.
- [ ] Confirm the existing published extension continues to work until the 2.0
      rollout is ready; avoid breaking the public 1.2 release prematurely.
- [ ] Determine and test the backend cutover/compatibility plan.
- [ ] Test the exact `build-extension-store/` artifact against the real review
      and production environment.
- [ ] Confirm the artifact is an update to the existing Web Store item, with
      the existing extension key/identity, not a new extension.
- [ ] Confirm the final listing, privacy-policy URL, permission disclosures,
      screenshots, and reviewer instructions match the shipped behavior.
- [ ] Do not deploy from this task.
