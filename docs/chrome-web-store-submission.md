# Copyyt 3.1 Chrome Web Store submission notes

This document is for the Chrome Web Store submission and release handoff. The
Store artifact is produced by `yarn build:store` at
`build-extension-store/`; that command pins both REST and Socket.IO endpoints
to `https://api.copyyt.com` rather than inheriting development `.env`
values. It is an update to the existing Copyyt Web Store item and must keep
the existing extension key/identity.

## Single purpose

Copyyt securely synchronizes clipboard content (text, formatted text and
images) between a user's trusted devices.

## Clipboard disclosure

When sending is enabled, Copyyt monitors the clipboard (text, formatted text
and PNG images) so that a normal copy on one trusted device can become
available for normal paste on another. Clipboard content is encrypted on-device
before transmission. Background clipboard monitoring happens only while sending
is enabled; users choose Send & receive, Send only, Receive only, or Paused for
each device.

Incoming text is written to the clipboard automatically. An incoming image is
held locally and shown in the popup; it is written to the clipboard only when
the user clicks "Copy image", because an MV3 extension can only write images
from a focused extension page.

Copyyt does not synchronize files and does not provide clipboard history.

## Permission justifications

The Store manifest retains the six permissions used by the implementation:

| Permission | Justification |
| --- | --- |
| `clipboardRead` | Reads text, formatted text and PNG images from the operating-system clipboard in the packaged offscreen document when the user enables sending, including automatic send mode. |
| `clipboardWrite` | Writes a trusted, decrypted incoming item to the operating-system clipboard so the user can paste it normally: text automatically, and images when the user clicks "Copy image" in the popup. |
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

Direct transfer between two of the user's devices on the same network uses
WebRTC in the offscreen document with no STUN/TURN servers (`iceServers: []`);
the connection offer and answer are relayed through the same API socket. It
needs no additional permission.

## Data-use disclosure checklist

Use the following factual categories and purposes when completing the Chrome
Web Store data-use questionnaire. Confirm the dashboard's exact labels at the
time of submission rather than copying labels from this document.

- Clipboard content (text, formatted text, PNG images): read while sending is
  enabled; encrypted on-device and sent as encrypted clipboard envelopes, or
  directly to the user's own device on the same network, for synchronization;
  written to the local clipboard when an authorized incoming item is received.
  A received image is kept as the still-encrypted item in extension-owned IndexedDB until
  the user copies it or it expires.
- Network connection details for direct transfer: local network candidates
  exchanged between the user's own devices through the server, only to set up
  a direct connection.
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
- iPhone waitlist: if the user taps "Notify me" in Settings, the account email
  is added to the iPhone waitlist, used only for the launch announcement.
- No analytics category is claimed here: the extension has no implemented
  analytics collection described by this release documentation.

## Reviewer test instructions

1. Install the submitted extension and sign in to Copyyt using the review
   account supplied through the Web Store review channel, if one is required.
2. Install/sign in to Copyyt on a second trusted browser installation and
   complete the displayed device pairing/fingerprint confirmation.
3. Select **Send & receive** on both devices.
4. Copy ordinary text on the first computer.
5. Paste normally on the second computer. The item should be available only as
   a short-lived encrypted live item.
6. Copy an image (for example, right-click an image in a web page and choose
   Copy image) on the first computer. On the second, open the Copyyt popup and
   click **Copy image**, then paste it into any app that accepts images.

Mode checks:

- **Send only**: clipboard changes on this device may be encrypted and sent;
  incoming items are not written to this device's clipboard.
- **Receive only**: this device does not monitor/send clipboard changes;
  authorized incoming items can be written to its clipboard.
- **Paused**: this device neither monitors/sends nor applies incoming clipboard
  items. The authenticated connection may remain available for account and
  pairing status.

Do not put passwords, OTPs, private tokens, or other test secrets in this
repository. Provide any review credentials through the Web Store's supported
private review channel.

## Suggested listing copy

### Short description

Sync copied text and images across your devices, end-to-end encrypted.

This is the manifest `description`; keep the two in step.

### Long description

Paste this as plain text: the Chrome Web Store does not render Markdown.

```text
Copy on one device. Paste on another.

Copyyt (pronounced "copy-it") keeps your clipboard in sync across the computers you trust. Copy text, formatted text or an image on one, and it's ready to paste on the next. No extra clicks, no emailing yourself links.

WHAT SYNCS
• Text: links, code, addresses, notes. Copied text arrives on your other devices automatically.
• Formatted text: bold, lists and links come along where the other device supports them.
• Images: a copied image appears in the Copyyt popup on your other computers; one click puts it on the clipboard.
• Direct transfer: when two devices are on the same network, larger images travel straight between them.

PRIVATE BY DESIGN
• End-to-end encrypted: everything is encrypted on your device before it leaves. The Copyyt server relays data it cannot read.
• Your keys stay on your devices, and a new device joins only after you confirm a matching code on a device you already trust.
• Nothing kept: encrypted items expire from the relay after 60 seconds, and Copyyt keeps no clipboard history.
• No ads and no tracking.

YOU'RE IN CONTROL
Choose how each device takes part:
• Send & receive: copies here reach your devices, and theirs land here.
• Send only: share copies from this device without changing its clipboard.
• Receive only: accept incoming items without watching local copies.
• Paused: nothing is sent or received on this device.

HOW TO START
1. Add Copyyt to Chrome and sign in with an email code or Google.
2. Install it on another computer and sign in with the same account.
3. Confirm the pairing code on both screens, then copy and paste as usual.

When sending is on, Copyyt watches the clipboard in the background so your copies sync automatically. Files are not synced.

Privacy policy: https://copyyt.com/privacy-policy
Questions: contact@copyyt.com
```

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
- [ ] Deploy the backend before submitting: 3.1 uses its account deletion,
      profile, plan and waitlist endpoints.
- [ ] Confirm the currently published version keeps working against the
      deployed backend until users update.
- [ ] Expect the API host change to `api.copyyt.com` to be a new host
      permission: Chrome may disable the update until users approve it.
- [ ] Set the listing's privacy-policy URL to
      `https://copyyt.com/privacy-policy` and paste the long description above.
- [ ] Test the exact `build-extension-store/` artifact against the real review
      and production environment.
- [ ] Confirm the artifact is an update to the existing Web Store item, with
      the existing extension key/identity, not a new extension.
- [ ] Confirm the final listing, privacy-policy URL, permission disclosures,
      screenshots, and reviewer instructions match the shipped behavior.
- [ ] Do not deploy from this task.
