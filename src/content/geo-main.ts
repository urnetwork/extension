// Geolocation override — MAIN world.
//
// Runs in the page's own realm at document_start, in every frame, before any
// page script. It replaces Geolocation.prototype's three methods (and
// Permissions.prototype.query for `{name:"geolocation"}`) so that pages are
// told the location of the oldest connected provider instead of the browser's
// real fix. See PROVIDERLOCATIONS.md, decision D-EXTOVERRIDE.
//
// Constraints this file lives under, all of them load-bearing:
//   • It executes under the *page's* CSP: no eval, no new Function, no
//     dynamic import, no external fetch. It is bundled standalone (see the
//     `crx:geo-content-scripts` plugin in vite.config.ts) precisely because
//     crxjs's content-script loader would need a dynamic import.
//   • document_start must not be forfeited. Nothing is awaited before the
//     patch goes in: the methods are wrapped synchronously and calls made
//     before the config arrives are *queued*, then either fabricated or handed
//     to the native implementation once it does.
//   • MAIN has no `chrome.*`. The config arrives from geo-config.ts (ISOLATED
//     world) over a DOM CustomEvent — see geo-protocol.ts.
//
// Honest about what this is: a per-page shim, not a browser guarantee. The
// fabricated GeolocationPosition has own data properties where a genuine one
// has none, `Function.prototype.toString` on a Proxy drops the function name
// (V8 renders "function () { [native code] }"), and the page shares the DOM
// with the config channel. A determined site can detect all of that.
import {
	GEO_CONFIG_EVENT,
	GEO_REQUEST_EVENT,
	type GeoConfigFrame,
	type GeoOverrideConfig,
} from "./geo-protocol";

type ActiveConfig = { active: true; lat: number; lon: number; accuracy: number };

type Watch = {
	id: number;
	geo: Geolocation;
	success: PositionCallback;
	failure: PositionErrorCallback | null;
	options: PositionOptions | undefined;
	/** our timer handle for fabricated updates (0 = none) */
	timer: number;
	/** whether `timer` is an interval rather than a timeout */
	repeating: boolean;
	/** native watch id when the call was delegated (0 = none) */
	nativeId: number;
};

// first fabricated fix lands after this delay (a real one is never instant)
const FIX_MIN_MS = 20;
const FIX_JITTER_MS = 90;
// cadence of repeat watchPosition updates
const WATCH_INTERVAL_MS = 10_000;
// if the ISOLATED companion never answers, stop queueing and pass through
const CONFIG_TIMEOUT_MS = 1_500;

const ERROR_TIMEOUT = 3;

function main(): void {
	const win = window;
	if (typeof Geolocation !== "function" || !Geolocation.prototype) return;

	// Captured before any page script runs, so a page that later patches these
	// cannot observe or break the shim.
	const setTimeoutNative = win.setTimeout.bind(win) as (fn: () => void, ms: number) => number;
	const clearTimeoutNative = win.clearTimeout.bind(win) as (id: number) => void;
	const setIntervalNative = win.setInterval.bind(win) as (fn: () => void, ms: number) => number;
	const clearIntervalNative = win.clearInterval.bind(win) as (id: number) => void;

	const geoProto = Geolocation.prototype;
	const getDesc = Object.getOwnPropertyDescriptor(geoProto, "getCurrentPosition");
	const watchDesc = Object.getOwnPropertyDescriptor(geoProto, "watchPosition");
	const clearDesc = Object.getOwnPropertyDescriptor(geoProto, "clearWatch");
	if (
		typeof getDesc?.value !== "function" ||
		typeof watchDesc?.value !== "function" ||
		typeof clearDesc?.value !== "function"
	) {
		return;
	}
	const nativeGet = getDesc.value as Geolocation["getCurrentPosition"];
	const nativeWatch = watchDesc.value as Geolocation["watchPosition"];
	const nativeClear = clearDesc.value as Geolocation["clearWatch"];

	const permsProto = typeof Permissions === "function" ? Permissions.prototype : null;
	const queryDesc = permsProto
		? Object.getOwnPropertyDescriptor(permsProto, "query")
		: undefined;
	const nativeQuery =
		typeof queryDesc?.value === "function"
			? (queryDesc.value as Permissions["query"])
			: null;
	const nativeStateGetter =
		typeof PermissionStatus === "function"
			? (Object.getOwnPropertyDescriptor(PermissionStatus.prototype, "state")?.get ?? null)
			: null;

	// ── state ────────────────────────────────────────────────────────────────
	// null until the ISOLATED companion (or the timeout) resolves it
	let config: GeoOverrideConfig | null = null;
	let installed = false;
	let pinnedToken: string | null = null;
	let nextWatchId = 1;
	const watches = new Map<number, Watch>();
	const pending: Array<() => void> = [];

	function activeConfig(): ActiveConfig | null {
		return config !== null && config.active ? config : null;
	}

	// Run now if the config is known, otherwise once it is. Geolocation's three
	// methods are asynchronous by specification, so deferring the *work* costs
	// nothing observable; deferring the *patch* would cost document_start.
	function run(fn: () => void): void {
		if (config === null) {
			pending.push(fn);
			return;
		}
		fn();
	}

	function flush(): void {
		if (config === null) return;
		const queued = pending.splice(0, pending.length);
		for (const fn of queued) {
			try {
				fn();
			} catch {
				// a page callback threw; there is no caller left to hand it to
			}
		}
	}

	// ── fabrication ──────────────────────────────────────────────────────────

	function defineValue(target: object, key: string, value: unknown): void {
		// non-enumerable: a genuine GeolocationPosition carries its properties on
		// the prototype, so Object.keys()/spread must stay empty.
		Object.defineProperty(target, key, {
			value,
			writable: false,
			enumerable: false,
			configurable: true,
		});
	}

	// Wrap an implementation in a Proxy over a native function so
	// `fn.toString()` still reports [native code].
	function nativeLike<T extends (...args: never[]) => unknown>(donor: unknown, impl: T): T {
		const target = typeof donor === "function" ? donor : nativeGet;
		return new Proxy(target as (...args: never[]) => unknown, {
			apply: (_target, thisArg, args) => Reflect.apply(impl, thisArg, args as never[]),
		}) as unknown as T;
	}

	function makeCoords(cfg: ActiveConfig): GeolocationCoordinates {
		const proto =
			typeof GeolocationCoordinates === "function"
				? GeolocationCoordinates.prototype
				: Object.prototype;
		const coords = Object.create(proto) as GeolocationCoordinates;
		defineValue(coords, "latitude", cfg.lat);
		defineValue(coords, "longitude", cfg.lon);
		defineValue(coords, "accuracy", cfg.accuracy);
		defineValue(coords, "altitude", null);
		defineValue(coords, "altitudeAccuracy", null);
		defineValue(coords, "heading", null);
		defineValue(coords, "speed", null);
		const plain = {
			accuracy: cfg.accuracy,
			latitude: cfg.lat,
			longitude: cfg.lon,
			altitude: null,
			altitudeAccuracy: null,
			heading: null,
			speed: null,
		};
		// a genuine instance inherits toJSON from the prototype, but that native
		// implementation reads internal slots we do not have and would throw
		defineValue(
			coords,
			"toJSON",
			nativeLike(
				(proto as { toJSON?: unknown }).toJSON,
				() => ({ ...plain }),
			),
		);
		return coords;
	}

	function makePosition(cfg: ActiveConfig): GeolocationPosition {
		const proto =
			typeof GeolocationPosition === "function"
				? GeolocationPosition.prototype
				: Object.prototype;
		// there is no GeolocationPosition constructor — `new` throws
		const position = Object.create(proto) as GeolocationPosition;
		const coords = makeCoords(cfg);
		const timestamp = Date.now();
		defineValue(position, "coords", coords);
		defineValue(position, "timestamp", timestamp);
		defineValue(
			position,
			"toJSON",
			nativeLike((proto as { toJSON?: unknown }).toJSON, () => ({
				coords: (coords as unknown as { toJSON: () => unknown }).toJSON(),
				timestamp,
			})),
		);
		return position;
	}

	function makeError(code: number, message: string): GeolocationPositionError {
		const proto =
			typeof GeolocationPositionError === "function"
				? GeolocationPositionError.prototype
				: Object.prototype;
		const error = Object.create(proto) as GeolocationPositionError;
		defineValue(error, "code", code);
		defineValue(error, "message", message);
		return error;
	}

	function fixDelay(): number {
		return FIX_MIN_MS + Math.floor(Math.random() * FIX_JITTER_MS);
	}

	function readTimeout(options: PositionOptions | undefined): number | null {
		if (!options || typeof options !== "object") return null;
		const raw = Number((options as { timeout?: unknown }).timeout);
		return Number.isFinite(raw) ? Math.max(0, raw) : null;
	}

	// ── watches ──────────────────────────────────────────────────────────────

	function stopTimer(watch: Watch): void {
		if (watch.timer === 0) return;
		if (watch.repeating) {
			clearIntervalNative(watch.timer);
		} else {
			clearTimeoutNative(watch.timer);
		}
		watch.timer = 0;
		watch.repeating = false;
	}

	function emit(watch: Watch): void {
		const cfg = activeConfig();
		if (!cfg) return;
		watch.success(makePosition(cfg));
	}

	function startWatch(watch: Watch): void {
		if (!watches.has(watch.id)) return; // cleared while the config was pending
		const cfg = activeConfig();
		if (!cfg) {
			watch.nativeId = Reflect.apply(nativeWatch, watch.geo, [
				watch.success,
				watch.failure,
				watch.options,
			]) as number;
			return;
		}
		watch.timer = setTimeoutNative(() => {
			watch.timer = 0;
			emit(watch);
			if (!watches.has(watch.id)) return;
			watch.timer = setIntervalNative(() => emit(watch), WATCH_INTERVAL_MS);
			watch.repeating = true;
		}, fixDelay());
	}

	// ── install / uninstall ──────────────────────────────────────────────────

	const proxyGet = new Proxy(nativeGet, {
		apply(target, thisArg, args: unknown[]) {
			const success = args[0];
			if (typeof success !== "function") {
				// let the native implementation raise the specified TypeError
				return Reflect.apply(target, thisArg, args as never[]);
			}
			const failure = typeof args[1] === "function" ? (args[1] as PositionErrorCallback) : null;
			const options = args[2] as PositionOptions | undefined;
			const geo = thisArg as Geolocation;
			run(() => {
				const cfg = activeConfig();
				if (!cfg) {
					Reflect.apply(target, geo, args as never[]);
					return;
				}
				const timeout = readTimeout(options);
				const delay = fixDelay();
				if (timeout !== null && timeout < delay) {
					if (failure) {
						setTimeoutNative(
							() => failure(makeError(ERROR_TIMEOUT, "Timeout expired")),
							timeout,
						);
					}
					return;
				}
				setTimeoutNative(() => {
					const current = activeConfig();
					if (!current) return;
					(success as PositionCallback)(makePosition(current));
				}, delay);
			});
			return undefined;
		},
	});

	const proxyWatch = new Proxy(nativeWatch, {
		apply(target, thisArg, args: unknown[]) {
			const success = args[0];
			if (typeof success !== "function") {
				return Reflect.apply(target, thisArg, args as never[]);
			}
			// a watch id must be returned synchronously, so one is issued even
			// when the config is still pending
			const watch: Watch = {
				id: nextWatchId++,
				geo: thisArg as Geolocation,
				success: success as PositionCallback,
				failure: typeof args[1] === "function" ? (args[1] as PositionErrorCallback) : null,
				options: args[2] as PositionOptions | undefined,
				timer: 0,
				repeating: false,
				nativeId: 0,
			};
			watches.set(watch.id, watch);
			run(() => startWatch(watch));
			return watch.id;
		},
	});

	const proxyClear = new Proxy(nativeClear, {
		apply(target, thisArg, args: unknown[]) {
			const id = Number(args[0]);
			const watch = watches.get(id);
			if (!watch) {
				return Reflect.apply(target, thisArg, args as never[]);
			}
			stopTimer(watch);
			if (watch.nativeId !== 0) {
				Reflect.apply(nativeClear, watch.geo, [watch.nativeId]);
			}
			watches.delete(id);
			return undefined;
		},
	});

	const proxyQuery =
		nativeQuery === null
			? null
			: new Proxy(nativeQuery, {
					apply(target, thisArg, args: unknown[]) {
						const result = Reflect.apply(target, thisArg, args as never[]) as Promise<
							PermissionStatus
						>;
						const descriptor = args[0] as { name?: unknown } | undefined;
						if (!descriptor || descriptor.name !== "geolocation") return result;
						if (!activeConfig()) return result;
						// Reporting "prompt" while fabricating positions is a one-line
						// tell, so the real PermissionStatus is mutated — it stays an
						// EventTarget and keeps firing its own change events.
						return result.then((status) => {
							try {
								Object.defineProperty(status, "state", {
									get: nativeLike(nativeStateGetter, () => "granted"),
									configurable: true,
									enumerable: true,
								});
							} catch {
								// frozen status object — leave it alone
							}
							return status;
						});
					},
				});

	function install(): void {
		if (installed) return;
		try {
			Object.defineProperty(geoProto, "getCurrentPosition", { ...getDesc, value: proxyGet });
			Object.defineProperty(geoProto, "watchPosition", { ...watchDesc, value: proxyWatch });
			Object.defineProperty(geoProto, "clearWatch", { ...clearDesc, value: proxyClear });
			if (permsProto && queryDesc && proxyQuery) {
				Object.defineProperty(permsProto, "query", { ...queryDesc, value: proxyQuery });
			}
		} catch {
			// a page froze the prototype before us — nothing to do
			return;
		}
		installed = true;
		// take over any watch that was delegated to the browser while the
		// override was off, so no real coordinates keep flowing once it is on
		for (const watch of watches.values()) {
			if (watch.nativeId !== 0) {
				Reflect.apply(nativeClear, watch.geo, [watch.nativeId]);
				watch.nativeId = 0;
			}
			if (watch.timer === 0) startWatch(watch);
		}
	}

	function uninstall(): void {
		if (!installed) return;
		installed = false;
		try {
			Object.defineProperty(geoProto, "getCurrentPosition", getDesc as PropertyDescriptor);
			Object.defineProperty(geoProto, "watchPosition", watchDesc as PropertyDescriptor);
			Object.defineProperty(geoProto, "clearWatch", clearDesc as PropertyDescriptor);
			if (permsProto && queryDesc) {
				Object.defineProperty(permsProto, "query", queryDesc);
			}
		} catch {
			// non-configurable now; the wrappers stay but pass through
		}
		// stop fabricating for watches we own. Their ids stay registered so
		// clearWatch() still accepts them.
		for (const watch of watches.values()) stopTimer(watch);
	}

	// ── config channel ───────────────────────────────────────────────────────

	function sanitize(value: unknown): GeoOverrideConfig | null {
		if (!value || typeof value !== "object") return null;
		const candidate = value as { active?: unknown; lat?: unknown; lon?: unknown; accuracy?: unknown };
		if (candidate.active !== true) return { active: false };
		const lat = Number(candidate.lat);
		const lon = Number(candidate.lon);
		const accuracy = Number(candidate.accuracy);
		if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
		if (!Number.isFinite(lon) || lon < -180 || lon > 180) return null;
		if (!Number.isFinite(accuracy) || accuracy <= 0) return null;
		return { active: true, lat, lon, accuracy };
	}

	function apply(next: GeoOverrideConfig): void {
		config = next;
		if (next.active) {
			install();
		} else {
			uninstall();
		}
		flush();
	}

	// Patch first, ask later. This is the whole reason the script is declarative
	// and self-contained: at document_start nothing is known yet, so the
	// wrappers go in immediately and calls are queued until the companion
	// answers. If the answer is "off", uninstall() below puts the original
	// descriptors back and the realm is left pristine.
	install();

	document.addEventListener(GEO_CONFIG_EVENT, (event) => {
		const detail = (event as CustomEvent<unknown>).detail;
		if (typeof detail !== "string") return;
		let frame: GeoConfigFrame | null = null;
		try {
			frame = JSON.parse(detail) as GeoConfigFrame;
		} catch {
			return;
		}
		if (!frame || typeof frame.token !== "string" || frame.token === "") return;
		// The page shares this DOM and can forge events. Pinning the first token
		// seen stops a site from switching the override off mid-visit to read the
		// real fix; it does not stop a site that forges one before the companion
		// answers, which is a known limit of any shared-DOM channel.
		if (pinnedToken === null) {
			pinnedToken = frame.token;
		} else if (pinnedToken !== frame.token) {
			return;
		}
		const next = sanitize(frame.config);
		if (next !== null) apply(next);
	});

	// the companion may already be waiting (world start order is not defined)
	try {
		document.dispatchEvent(new CustomEvent(GEO_REQUEST_EVENT));
	} catch {
		// document not ready — the companion pushes unprompted as well
	}

	// never queue forever: if nothing answers, behave exactly like no extension
	setTimeoutNative(() => {
		if (config === null) apply({ active: false });
	}, CONFIG_TIMEOUT_MS);
}

main();
