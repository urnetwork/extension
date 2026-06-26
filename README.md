# URnetwork Browser Extension

A cross-browser extension for [URnetwork](https://ur.network), built with:

- [Vite](https://vitejs.dev)
- [React](https://react.dev)
- [TypeScript](https://www.typescriptlang.org)
- [CRXJS Vite Plugin](https://crxjs.dev/vite-plugin)
- Manifest V3

---

## Quick install from a release

The fastest way to install the extension is from a pre-built release archive.

### Where to get releases

- Check the [`release/`](./release) folder in this repository
- Or visit the [GitHub Releases page](https://github.com/Ryanmello07/urnetwork-extension/releases)

Each release provides two ZIP files:

| File | Browser |
|------|---------|
| `crx-@urnetwork-extension-<version>.zip` | Chrome / Chromium / Edge |
| `crx-@urnetwork-extension-<version>-firefox.zip` | Firefox |

---

## Install on Chrome / Chromium / Edge

1. Open `chrome://extensions/` in your browser.
2. Enable **Developer mode** (toggle in the top-right).
3. Drag and drop the Chrome ZIP file (`crx-@urnetwork-extension-<version>.zip`) onto the extensions page.
4. The extension should install automatically.
5. Click the puzzle-icon in the toolbar and pin URnetwork for easy access.

### Alternative: load unpacked

1. Extract the ZIP to a folder.
2. Open `chrome://extensions/` and enable **Developer mode**.
3. Click **Load unpacked** and select the extracted folder.

---

## Install on Firefox

Firefox requires a temporary install through `about:debugging`. This is because the release is packaged as an unsigned extension ZIP.

1. Open Firefox.
2. Navigate to `about:debugging`.
3. Click **This Firefox** on the left.
4. Click **Load Temporary Add-on…**.
5. Select the Firefox ZIP file (`crx-@urnetwork-extension-<version>-firefox.zip`) and open it.
6. The extension icon will appear in the toolbar.

> ⚠️ Temporary add-ons remain installed only for the current Firefox session. You will need to repeat these steps after restarting Firefox.

---

## Build from source

### Requirements

- [Node.js](https://nodejs.org/) 22+
- [npm](https://www.npmjs.com/)
- Git

### Clone the repository

```bash
git clone git@github.com:Ryanmello07/urnetwork-extension.git
cd urnetwork-extension
```

### Install dependencies

```bash
npm ci
```

### Build for Chrome

```bash
npm run build
```

Output is generated in `dist/` and packaged as:

```
release/crx-@urnetwork-extension-<version>.zip
```

### Build for Firefox

```bash
npm run build:firefox
```

Output is generated in `dist-firefox/` and packaged as:

```
release/crx-@urnetwork-extension-<version>-firefox.zip
```

The Firefox build runs a post-build patch (`scripts/patch-firefox-build.js`) that converts the service-worker background to a script-based background, adjusts `host_permissions`, removes `use_dynamic_url`, and adds the required `browser_specific_settings.gecko` block.

---

## Load a local build in the browser

### Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `dist/` directory

### Firefox

1. Open `about:debugging`
2. Click **This Firefox**
3. Click **Load Temporary Add-on…**
4. Select `dist-firefox/manifest.json`

---

## Develop locally

```bash
npm run dev
```

Starts the Vite development server with HMR for the popup UI.

---

## Linting

```bash
npm run lint
```

---

## Versioning

The project uses npm for version bumps. Available scripts:

```bash
npm run version:patch   # 0.1.4 -> 0.1.5
npm run version:minor   # 0.1.4 -> 0.2.0
npm run version:major   # 0.1.4 -> 1.0.0
```

The version is read from `package.json` and injected into:

- `manifest.json`
- `__EXTENSION_VERSION__` available in the source code

---

## License

See [LICENSE](./LICENSE).