// The popup's text comes from the extension's locale catalogs (B6, owner
// approval 2026-11-11), which scripts/build-locales.js generates from the
// localization store's keys tagged web. Chrome shows an empty string for a key
// its catalog lacks, so every key the popup and the background look up must be
// in every catalog, translated: a key the store has not tagged web would read
// as nothing, and one left in English would read as English.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { catalog } from "./chrome-mock";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return sources(full);
		return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
	});
}

// every literal key passed to getMessage in src/
function lookedUpKeys(): string[] {
	const keys = new Set<string>();
	for (const file of sources(path.join(ROOT, "src"))) {
		const text = readFileSync(file, "utf8");
		for (const match of text.matchAll(/getMessage\(\s*"([a-z0-9_]+)"/g)) keys.add(match[1]);
		// keys chosen between two literals: getMessage(x ? "a" : "b")
		for (const match of text.matchAll(/getMessage\(\s*[^()"]*\?\s*"([a-z0-9_]+)"\s*:\s*"([a-z0-9_]+)"/g)) {
			keys.add(match[1]);
			keys.add(match[2]);
		}
	}
	// the duration strings out-of-balance.ts lowers the countdown into
	keys.add("provider_connected_duration_hours");
	keys.add("provider_connected_duration_minutes");
	keys.add("insufficient_balance_refreshes_in");
	return [...keys].sort();
}

const LOCALES = readdirSync(path.join(ROOT, "public/_locales"));

describe("the popup's text", () => {
	it("every key it looks up is in every catalog", () => {
		const keys = lookedUpKeys();
		expect(keys.length).toBeGreaterThan(40);
		const missing: string[] = [];
		for (const locale of LOCALES) {
			const messages = catalog(locale);
			for (const key of keys) {
				if (!messages[key]?.message) missing.push(`${locale}: ${key}`);
			}
		}
		expect(missing).toEqual([]);
	});

	it("the status labels and messages it used to hard-code are keys, translated", () => {
		const keys = [
			"connected",
			"disconnected",
			"site_app_connecting",
			"extension_status_proxy_not_answering",
			"extension_proxy_unreachable_kill_switch",
			"extension_proxy_fell_back",
			"extension_connect_failed",
			"extension_proxy_active_network_unreachable",
			"extension_kill_switch_blocks_on_failure",
			"extension_kill_switch_may_leak_on_failure",
			"extension_ip_checking",
			"extension_ip_unavailable",
			// kill_switch is left out: de, es, fr and ru keep "Kill switch" as is
			"sign_out",
		];
		const english = catalog("en");
		const untranslated: string[] = [];
		for (const locale of ["de", "es", "fr", "ja", "ru", "zh_CN", "ar"]) {
			for (const key of keys) {
				if (catalog(locale)[key]?.message === english[key]?.message) untranslated.push(`${locale}: ${key}`);
			}
		}
		expect(untranslated).toEqual([]);
	});

	it("no status label or message is hard-coded English any more", () => {
		const hardCoded = [
			"Proxy not answering",
			"Proxy active but network unreachable.",
			"Blocks traffic on failure",
			"Traffic may leak on failure",
			"Checking IP...",
			"IP unavailable",
			"Failed to connect. Check your account.",
			"Toggle kill switch",
			">Logout<",
		];
		const found: string[] = [];
		for (const file of [
			"src/popup/components/ConnectScreen.tsx",
			"src/popup/components/IpInfoBanner.tsx",
			"src/popup/components/OutOfDataNotice.tsx",
			"src/utils/connection-manager.ts",
		]) {
			const text = readFileSync(path.join(ROOT, file), "utf8");
			for (const literal of hardCoded) if (text.includes(literal)) found.push(`${file}: ${literal}`);
		}
		expect(found).toEqual([]);
	});

	// The extension signs in with a session of its own (owner decision
	// 2026-11-18), so its code sign-in can meet the account's cap of active
	// sessions: the line that says so (tagged web in localizations c63dded) is
	// in every catalog, translated, and the popup no longer shows the server's
	// English for a refusal.
	it("the session cap's refusal of a code sign-in is a key, translated", () => {
		const english = catalog("en").sessions_limit_reached_sign_in?.message;
		expect(english).toMatch(/Account > Sessions/);
		const untranslated: string[] = [];
		for (const locale of ["de", "es", "fr", "ja", "ru", "zh_CN", "ar"]) {
			if (catalog(locale).sessions_limit_reached_sign_in?.message === english) untranslated.push(locale);
		}
		expect(untranslated).toEqual([]);
		const popup = readFileSync(path.join(ROOT, "src/popup/components/AuthInitial.tsx"), "utf8");
		expect(popup).not.toMatch(/error\.message/);
	});
});
