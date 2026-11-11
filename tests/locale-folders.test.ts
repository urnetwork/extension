// The extension's locale catalogs (public/_locales, written by
// scripts/build-locales.js from the localization store) sit under folder names
// the browsers load. Chrome loads only the locales it lists, with an
// underscore before the region, and ignores any other folder
// (developer.chrome.com/docs/extensions/reference/api/i18n#locales); Firefox
// wants the same underscore form and falls back from a region to its
// language, then to default_locale (MDN, WebExtensions Internationalization).
// Until 2026-11-11 the store's codes were written as they are (pt-BR, pt-PT,
// es-419, es-MX, zh, zh-HK, pt), and no browser loaded those seven: Brazilian,
// Latin American Spanish and Chinese readers got English or another variant.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { catalog } from "./chrome-mock";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Chrome's supported locales, as its i18n reference lists them
const CHROME_LOCALES = [
	"ar", "am", "bg", "bn", "ca", "cs", "da", "de", "el", "en", "en_AU", "en_GB", "en_US",
	"es", "es_419", "et", "fa", "fi", "fil", "fr", "gu", "he", "hi", "hr", "hu", "id", "it",
	"ja", "kn", "ko", "lt", "lv", "ml", "mr", "ms", "nl", "no", "pl", "pt_BR", "pt_PT", "ro",
	"ru", "sk", "sl", "sr", "sv", "sw", "ta", "te", "th", "tr", "uk", "vi", "zh_CN", "zh_TW",
];

const folders = () => readdirSync(path.join(ROOT, "public/_locales")).sort();

describe("the extension's locale folders", () => {
	it("are all locales Chrome lists, in its underscore form", () => {
		expect(folders().filter((folder) => !CHROME_LOCALES.includes(folder))).toEqual([]);
	});

	it("include the manifest's default_locale", () => {
		const manifest = readFileSync(path.join(ROOT, "manifest.config.ts"), "utf8");
		const defaultLocale = manifest.match(/default_locale:\s*"([^"]+)"/)?.[1];
		expect(defaultLocale).toBe("en");
		expect(folders()).toContain(defaultLocale);
	});

	it("carry the store's regional variants under the codes the browsers load", () => {
		expect(folders()).toEqual(expect.arrayContaining(["pt_BR", "pt_PT", "es_419", "zh_CN", "zh_TW"]));
		// the store's zh is Simplified Chinese, its zh-HK Traditional
		expect(catalog("zh_CN").connect?.message).toBe("连接");
		expect(catalog("zh_TW").disconnect?.message).toMatch(/[斷連]/);
		// the same keys in every folder as in English
		const english = Object.keys(catalog("en")).sort();
		for (const folder of folders()) {
			expect(Object.keys(catalog(folder)).length, folder).toBeGreaterThan(english.length * 0.9);
		}
	});
});
