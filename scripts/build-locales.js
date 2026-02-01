// @ts-nocheck
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadAllKeys } from "@urnetwork/localizations";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.join(__dirname, "../public/_locales");

// Project-specific language mapping
const langMap = {
	jp: "ja",
	en: "en",
};

function buildChromeLocales() {
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

buildChromeLocales();
