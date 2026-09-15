# Copyyt Chrome extension

The extension’s Phase 1D crypto core is framework-independent and uses Chrome
137+ WebCrypto primitives: Ed25519 device signatures, X25519 key agreement,
HKDF-SHA-256, and AES-256-GCM. Plaintext clipboard contents and private keys
are not sent to the backend.

Device private keys are generated once and persisted as non-extractable
`CryptoKey` objects in IndexedDB. Only raw 32-byte public keys, encoded as
canonical padded standard Base64, are used in device registration and protocol
messages. The crypto core also enforces the local trust-store state before a
device can receive a wrapped content key.

Phase 1D deliberately does not add clipboard monitoring, an offscreen
document, or a persistent Socket.IO lifecycle. Those belong to the next phase.

## Development

```bash
yarn build
yarn lint
yarn test:crypto
```

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
