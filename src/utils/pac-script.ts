import { pacBypassConditions, deviceRpcApiHost } from "./bypass-rules";

export interface PacSlot {
	host: string;
	port: number;
}

export interface BuildPacOptions {
	killSwitch?: boolean;
}

export function buildPacScript(slots: PacSlot[], options: BuildPacOptions = {}): string {
	const { killSwitch = true } = options;

	if (slots.length === 0) {
		if (killSwitch) {
			return `function FindProxyForURL() { return "PROXY 0.0.0.0:1"; }`;
		}
		return `function FindProxyForURL() { return "DIRECT"; }`;
	}

	const proxyList = slots
		.map((s) => `HTTPS ${s.host}:${s.port}`)
		.join("; ");

	const fallback = killSwitch ? "" : "; DIRECT";

	// each slot's own device-rpc api host stays direct (see deviceRpcApiHost)
	const apiHosts = slots
		.map((s) => deviceRpcApiHost(s.host))
		.filter((h): h is string => h !== null);

	return `function FindProxyForURL(url, host) {
  ${pacBypassConditions(apiHosts)}
  return "${proxyList}${fallback}";
}`;
}

export function pacScriptToDataUrl(script: string): string {
	return "data:application/x-ns-proxy-autoconfig;base64," +
		btoa(unescape(encodeURIComponent(script)));
}
