// @ts-nocheck
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Prefer the sibling store checkout over the published package, the way
// mmm/ur.io's build-locales.mjs does. The package dependency is pinned
// "^0.0.6", and for 0.0.x versions npm treats caret as exact — so a key added
// to the store is invisible here until the package is BOTH republished and the
// dependency bumped. That failure is silent: messages.json regenerates without
// the new strings and the UI ships raw key ids. The package remains the
// fallback so a standalone clean install still builds.
const SIBLING_STORE = path.resolve(__dirname, "../../localizations");

async function resolveLoadAllKeys() {
	const siblingIndex = path.join(SIBLING_STORE, "index.js");
	if (fs.existsSync(siblingIndex)) {
		const mod = await import(pathToFileURL(siblingIndex).href);
		const fn = mod.loadAllKeys || mod.default?.loadAllKeys;
		if (typeof fn === "function") {
			console.log(`localizations: using sibling store at ${SIBLING_STORE}`);
			return fn;
		}
	}
	const pkg = await import("@urnetwork/localizations");
	const fn = pkg.loadAllKeys || pkg.default?.loadAllKeys;
	if (typeof fn !== "function") {
		throw new TypeError("@urnetwork/localizations did not expose loadAllKeys");
	}
	console.log("localizations: using the published @urnetwork/localizations package");
	return fn;
}
const outputDir = path.join(__dirname, "../public/_locales");

// Project-specific language mapping
const langMap = {
	jp: "ja",
	en: "en",
};

async function buildChromeLocales() {
	const loadAllKeys = await resolveLoadAllKeys();
	// Clear output
	if (fs.existsSync(outputDir)) {
		fs.rmSync(outputDir, { recursive: true });
	}

	// Load all keys from localizations package
	const allKeys = loadAllKeys();

	// Build messages by language
	const messagesByLang = {};

	Object.entries(allKeys).forEach(([keyName, keyData]) => {
		Object.entries(keyData.localizations).forEach(([lang, message]) => {
			if (!messagesByLang[lang]) {
				messagesByLang[lang] = {};
			}

			messagesByLang[lang][keyName] = {
				message,
				description: keyData.description || "",
			};
		});
	});

	// Write to Chrome format
	Object.entries(messagesByLang).forEach(([lang, messages]) => {
		const chromeLang = langMap[lang] || lang;
		const langDir = path.join(outputDir, chromeLang);
		fs.mkdirSync(langDir, { recursive: true });
		fs.writeFileSync(
			path.join(langDir, "messages.json"),
			JSON.stringify(messages, null, 2),
		);
	});

	console.log(
		`✅ Built Chrome locales for: ${Object.keys(messagesByLang).join(", ")}`,
	);
}

buildChromeLocales().catch((err) => {
	console.error(err);
	process.exit(1);
});
