import { describe, expect, it } from "vitest";

import { isAllowedResolvedAddress, isPublicAddress, resolveAllowedAddresses, validateRequestUrl } from "../../src/web-tools/network-policy.js";

describe("webfetch network policy", () => {
	it("只允许 http/https 且拒绝 userinfo、localhost 和字面私网 IP", () => {
		expect(validateRequestUrl("https://example.com/a#frag")).toMatchObject({ displayUrl: "https://example.com/a" });
		expect(validateRequestUrl("http://example.com")).toMatchObject({ displayUrl: "http://example.com/" });
		expect(validateRequestUrl("file:///etc/passwd")).toMatchObject({ status: "failed", error: { code: "INVALID_URL" } });
		expect(validateRequestUrl("https://u:p@example.com")).toMatchObject({ status: "failed", error: { code: "INVALID_URL" } });
		expect(validateRequestUrl("https://localhost")).toMatchObject({ status: "failed", error: { code: "BLOCKED_ADDRESS" } });
		expect(validateRequestUrl("http://127.0.0.1")).toMatchObject({ status: "failed", error: { code: "BLOCKED_ADDRESS" } });
		expect(validateRequestUrl("http://[::1]")).toMatchObject({ status: "failed", error: { code: "BLOCKED_ADDRESS" } });
	});

	it("只把全球单播公网地址视为允许", () => {
		expect(isPublicAddress("8.8.8.8")).toBe(true);
		expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
		expect(isPublicAddress("10.0.0.1")).toBe(false);
		expect(isPublicAddress("192.168.1.1")).toBe(false);
		expect(isPublicAddress("169.254.169.254")).toBe(false);
		expect(isPublicAddress("::1")).toBe(false);
		expect(isPublicAddress("fc00::1")).toBe(false);
		expect(isPublicAddress("::ffff:192.168.1.1")).toBe(false);
	});

	it("混合公网和私网 DNS 结果整体拒绝", async () => {
		await expect(
			resolveAllowedAddresses("example.com", {
				lookup: async () => [
					{ address: "8.8.8.8", family: 4 },
					{ address: "10.0.0.1", family: 4 },
				],
			}),
		).rejects.toMatchObject({ name: "BLOCKED_ADDRESS" });
	});

	it("配置的 fake-ip CIDR 只放行 DNS 解析结果，不放行 URL 字面 IP", async () => {
		expect(isAllowedResolvedAddress("198.18.2.86", ["198.18.0.0/15"])).toBe(true);
		await expect(
			resolveAllowedAddresses("example.com", {
				allowedFakeIpRanges: ["198.18.0.0/15"],
				lookup: async () => [{ address: "198.18.2.86", family: 4 }],
			}),
		).resolves.toEqual([{ address: "198.18.2.86", family: 4 }]);
		expect(validateRequestUrl("https://198.18.2.86/")).toMatchObject({ status: "failed", error: { code: "BLOCKED_ADDRESS" } });
	});
});
