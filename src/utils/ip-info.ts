import { createURNetworkApiClient } from "@urnetwork/sdk/client";

// my-ip-info is asked of the api-v4 host, as it always was, not the client's
// default api host. No retry: the banner polls, and a failed read must show
// as one.
const ipInfoApi = createURNetworkApiClient({
	baseURL: "https://api-v4.bringyour.com",
	retry: false,
});

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

	// rejects (URNetworkApiError) on a non-2xx or a network failure
	const data = await ipInfoApi.myIpInfo();
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
