// Country code to color hex mapping
export const countryCodeColorHexes: Record<string, string> = {
	is: "639A88",
	ee: "78C0E0",
	ca: "449DD1",
	de: "663F46",
	au: "F29E4C",
	us: "BAC5B3",
	gb: "F1789B",
	jp: "CC3363",
	ie: "7EE081",
	fi: "F56E48",
	nl: "F56E48",
	se: "A4C4F4",
	fr: "A864DC",
	it: "F9F871",
	dk: "D6E6F4",
	no: "BCE5DC",
	be: "9B4A91",
	at: "FFCB68",
	ch: "FFABA0",
	nz: "008A64",
	pt: "248C89",
	es: "B41F43",
	lv: "EEE8A9",
	lt: "8179E0",
	cz: "99E8CE",
	si: "FF6C58",
	sk: "87FB67",
	pl: "D38B5D",
	hu: "FF8484",
	hr: "99B2DD",
	ro: "C6362F",
	bg: "A1CDF4",
	gr: "C874D9",
	cy: "E1BBC9",
	mt: "FFC43D",
	il: "A9E4EF",
	za: "F2B79F",
	ar: "8E8DBE",
	br: "DCD6F7",
	cl: "FA824C",
	cr: "E07A5F",
	uy: "7FDEFF",
	jm: "7B886F",
	tt: "0072BB",
	gh: "1098F7",
	ke: "F2EDEB",
	ng: "64113F",
	tn: "6B4D57",
	sn: "596869",
	na: "813405",
	bw: "D45113",
	mu: "60E1E0",
	mg: "F25D72",
	in: "F2E2D2",
	kr: "C320D9",
	tw: "E6EA23",
	my: "3A1772",
	ph: "B4CEB3",
	id: "586189",
	mn: "A6A57A",
	ge: "679436",
	am: "F2B5D4",
	ua: "00F28D",
	md: "7F675B",
	me: "E5FFDE",
	rs: "FF495C",
	al: "E4B363",
};

/**
 * Convert hex color string to RGB tuple
 */
function hexToRGB(hex: string): [number, number, number] {
	// Remove # if present
	const cleanHex = hex.replace("#", "");
	const n = parseInt(cleanHex, 16);
	return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Convert RGB values to hex color string
 */
function rgbToHex(r: number, g: number, b: number): string {
	return (
		"#" +
		[r, g, b]
			.map((x) => {
				const h = x.toString(16);
				return h.length === 1 ? "0" + h : h;
			})
			.join("")
	);
}

/**
 * Simple hash function to generate consistent index from string
 * This approximates MD5 behavior for our use case
 */
function simpleHash(str: string): number {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash; // Convert to 32-bit integer
	}
	return Math.abs(hash);
}

/**
 * Generate a consistent hash index from a string
 * Mimics Go's md5.Sum([]byte(id))[0] % mod
 */
function getHashIndex(id: string, mod: number): number {
	if (mod === 0) return 0;
	const hash = simpleHash(id);
	// Take lower byte to mimic Go's behavior of taking first byte of MD5
	return (hash & 0xff) % mod;
}

/**
 * Mix two hex colors by averaging their RGB components
 */
function mixColors(color1: string, color2: string): string {
	const [r1, g1, b1] = hexToRGB(color1);
	const [r2, g2, b2] = hexToRGB(color2);
	const r = Math.round((r1 + r2) / 2);
	const g = Math.round((g1 + g2) / 2);
	const b = Math.round((b1 + b2) / 2);
	return rgbToHex(r, g, b);
}

/**
 * Get color hex for a given key (country code or location ID)
 * If the key matches a country code, returns the mapped color
 * Otherwise generates a color by mixing two colors from the map
 */
export function getColorHex(key: string): string {
	const code = key.toLowerCase();

	// Check if we have a direct mapping
	if (countryCodeColorHexes[code]) {
		return "#" + countryCodeColorHexes[code];
	}

	// Fallback: generate color by mixing two colors
	const keys = Object.keys(countryCodeColorHexes).sort();
	const index1 = getHashIndex(code, keys.length);
	const index2 = getHashIndex(code + "salt", keys.length);

	const color1 = countryCodeColorHexes[keys[index1]];
	const color2 = countryCodeColorHexes[keys[index2]];

	return mixColors(color1, color2);
}
