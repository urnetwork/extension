import { pacBypassConditions, deviceRpcApiHost } from "./bypass-rules";
import { getStoredApiHost } from "./api-config";

export interface PacSlot {
	host: string;
	port: number;
}

export interface BuildPacOptions {
	killSwitch?: boolean;
}

export async function buildPacScript(slots: PacSlot[], options: BuildPacOptions = {}): Promise<string> {
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
	const deviceHosts = slots
		.map((s) => deviceRpcApiHost(s.host))
		.filter((h): h is string => h !== null);

	// a configured custom API host must also stay direct, or the extension
	// can't reach it while the VPN is routing everything else
	const customApiHost = await getStoredApiHost();

	return `function FindProxyForURL(url, host) {
  ${pacBypassConditions([...deviceHosts, customApiHost])}
  return "${proxyList}${fallback}";
}`;
}

export function pacScriptToDataUrl(script: string): string {
	return "data:application/x-ns-proxy-autoconfig;base64," +
		btoa(unescape(encodeURIComponent(script)));
}
