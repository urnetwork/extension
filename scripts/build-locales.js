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

// The store's locale (BCP-47, keys/*.yaml) -> the _locales folder the browsers
// load. Chrome loads only the locales it lists, with an underscore before the
// region (developer.chrome.com/docs/extensions/reference/api/i18n#locales: "If
// you use an unsupported locale, Google Chrome ignores it"), and Firefox wants
// the same underscore form (MDN, WebExtensions Internationalization) and falls
// back from a region to its language, then to default_locale ("en",
// manifest.config.ts). A hyphenated folder, or one Chrome does not list, is
// never loaded: until 2026-11-11 pt-BR, pt-PT, es-419, zh and zh-HK shipped
// that way, and those readers saw English or another variant.
// null: the store has the locale, and the extension ships no folder for it.
const EXTENSION_LOCALE = {
	en: "en",
	ar: "ar",
	cs: "cs",
	de: "de",
	el: "el",
	es: "es",
	"es-419": "es_419",
	// Chrome has no es_MX: Mexico's Chrome reads es_419, and Firefox es-MX falls
	// back to es
	"es-MX": null,
	fr: "fr",
	he: "he",
	hi: "hi",
	id: "id",
	it: "it",
	ja: "ja",
	ko: "ko",
	nl: "nl",
	pl: "pl",
	// Chrome has no bare pt: Brazil reads pt_BR, Portugal pt_PT
	pt: null,
	"pt-BR": "pt_BR",
	"pt-PT": "pt_PT",
	ru: "ru",
	sv: "sv",
	sw: "sw",
	th: "th",
	uk: "uk",
	vi: "vi",
	// the store's zh is Simplified Chinese
	zh: "zh_CN",
	// the store's Traditional Chinese; Chrome's one Traditional locale is zh_TW
	"zh-HK": "zh_TW",
};

function extensionLocale(storeLocale) {
	if (!(storeLocale in EXTENSION_LOCALE)) {
		throw new Error(
			`build-locales: the store has locale ${storeLocale}, which has no _locales folder decided: add it to EXTENSION_LOCALE`,
		);
	}
	return EXTENSION_LOCALE[storeLocale];
}

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
	const built = [];
	const skipped = [];
	Object.entries(messagesByLang).forEach(([lang, messages]) => {
		const folder = extensionLocale(lang);
		if (folder === null) {
			skipped.push(lang);
			return;
		}
		const langDir = path.join(outputDir, folder);
		fs.mkdirSync(langDir, { recursive: true });
		fs.writeFileSync(
			path.join(langDir, "messages.json"),
			JSON.stringify(messages, null, 2),
		);
		built.push(folder);
	});

	console.log(
		`✅ Built Chrome locales for: ${built.join(", ")}` +
			(skipped.length ? ` (no folder for the store's ${skipped.join(", ")})` : ""),
	);
}

buildChromeLocales().catch((err) => {
	console.error(err);
	process.exit(1);
});
