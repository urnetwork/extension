import fs from 'node:fs';
import path from 'node:path';

const distDir = path.resolve('dist-firefox');
const manifestPath = path.join(distDir, 'manifest.json');

if (!fs.existsSync(manifestPath)) {
  throw new Error('dist-firefox/manifest.json not found. Run npm run build:firefox first.');
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// Modern crxjs respects the firefox-style `background.scripts` input and emits
// the built entry there (e.g. assets/index.ts-*.js) — preserve it. Older crxjs
// emitted `background.service_worker` + a service-worker-loader.js shim, which
// firefox needs translated to `scripts`. Either way the referenced file must
// exist in the dist: a bad name here ships an extension whose background never
// loads (every bridge/proxy feature silently dead).
const existingScripts = Array.isArray(manifest.background?.scripts)
  ? manifest.background.scripts.filter((s) => typeof s === 'string' && s)
  : [];
const scripts = existingScripts.length
  ? existingScripts
  : [manifest.background?.service_worker || 'service-worker-loader.js'];
for (const script of scripts) {
  if (!fs.existsSync(path.join(distDir, script))) {
    throw new Error(`dist-firefox background script missing: ${script}`);
  }
}
manifest.background = {
  scripts,
  type: 'module'
};

manifest.permissions = Array.from(new Set([...(manifest.permissions || []), 'proxy', 'storage']));
manifest.host_permissions = Array.from(new Set([
  '<all_urls>',
  ...(manifest.host_permissions || []),
]));

manifest.browser_specific_settings = {
  gecko: {
    id: 'urnetwork@bringyour.com',
    strict_min_version: '128.0',
    data_collection_permissions: {
      required: ['none']
    }
  }
};

if (Array.isArray(manifest.web_accessible_resources)) {
  manifest.web_accessible_resources = manifest.web_accessible_resources.map((entry) => {
    const next = { ...entry };
    next.matches = ['<all_urls>'];
    delete next.use_dynamic_url;
    return next;
  });
}

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('Patched dist-firefox/manifest.json for Firefox.');
