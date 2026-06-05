export interface IpInfo {
	ip: string;
	city: string;
	region: string;
	countryCode: string;
	countryName: string;
	connectedToNetwork: boolean;
}

const IP_INFO_RATE_LIMIT_MS = 500;
let lastFetchAt = 0;
let lastResult: IpInfo | null = null;

export async function fetchIpInfo(): Promise<IpInfo> {
	const now = Date.now();
	if (now - lastFetchAt < IP_INFO_RATE_LIMIT_MS && lastResult !== null) {
		return lastResult;
	}
	lastFetchAt = now;

	const res = await fetch("https://api-v4.bringyour.com/my-ip-info");
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data = await res.json();
	const loc = data.info?.location ?? {};
	lastResult = {
		ip: data.info?.ip ?? "",
		city: loc.city ?? "",
		region: loc.region ?? "",
		countryCode: loc.country?.code?.toUpperCase() ?? "",
		countryName: loc.country?.name ?? "",
		connectedToNetwork: data.connected_to_network === true,
	};
	return lastResult;
}
