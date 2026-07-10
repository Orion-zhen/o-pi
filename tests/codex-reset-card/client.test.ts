import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectCodexResetCardSnapshot, extractCards, parseApiDate, parseCodexAccessToken } from "../../src/codex-reset-card/client.js";
import { CodexResetCardError } from "../../src/codex-reset-card/types.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("codex-reset-card-");

describe("codex reset card client", () => {
	it("从 Codex auth 常见结构读取 access token", () => {
		expect(parseCodexAccessToken({ tokens: { access_token: "nested" } })).toBe("nested");
		expect(parseCodexAccessToken({ access_token: "top-level" })).toBe("top-level");
		expect(parseCodexAccessToken({ tokens: {} })).toBeUndefined();
		expect(parseCodexAccessToken(null)).toBeUndefined();
	});

	it("解析秒、毫秒、数字字符串和 ISO 时间", () => {
		expect(parseApiDate(1_783_296_000)?.toISOString()).toBe("2026-07-06T00:00:00.000Z");
		expect(parseApiDate(1_783_296_000_000)?.toISOString()).toBe("2026-07-06T00:00:00.000Z");
		expect(parseApiDate("1783296000")?.toISOString()).toBe("2026-07-06T00:00:00.000Z");
		expect(parseApiDate("2026-07-06T00:00:00Z")?.toISOString()).toBe("2026-07-06T00:00:00.000Z");
		expect(parseApiDate("not a date")).toBeUndefined();
	});

	it("兼容顶层和一层嵌套的卡片列表与时间字段", () => {
		const cards = extractCards({
			data: {
				items: [
					{
						grant: { created_at: "2026-07-01T00:00:00Z" },
						window: { expires_at: "2026-07-08T00:00:00Z" },
					},
					{
						available_at: "2026-07-02T00:00:00Z",
						valid_until: "2026-07-09T00:00:00Z",
						used_at: "2026-07-03T00:00:00Z",
					},
				],
			},
		});

		expect(cards).toHaveLength(2);
		expect(cards[0]?.issuedAt?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
		expect(cards[0]?.expiresAt?.toISOString()).toBe("2026-07-08T00:00:00.000Z");
		expect(cards[1]?.usedAt?.toISOString()).toBe("2026-07-03T00:00:00.000Z");
	});

	it("未知 JSON 结构只暴露顶层字段名", () => {
		expect(() => extractCards({ answer: 42, secret: "hidden" })).toThrow(CodexResetCardError);
		try {
			extractCards({ answer: 42, secret: "hidden" });
		} catch (error) {
			expect(error).toBeInstanceOf(CodexResetCardError);
			expect((error as CodexResetCardError).code).toBe("unexpected_json_shape");
			expect((error as CodexResetCardError).details).toEqual({ topLevelKeys: ["answer", "secret"] });
		}
	});

	it("用 Codex token 请求重置卡接口并生成系统时区快照", async () => {
		const dir = temp.path;
		const authPath = join(dir, "auth.json");
		await writeFile(authPath, JSON.stringify({ tokens: { access_token: "test-token" } }), "utf8");

		let authorization: string | undefined;
		const fetchImpl: typeof fetch = async (_url, init) => {
			const headers = new Headers(init?.headers);
			authorization = headers.get("Authorization") ?? undefined;
			return new Response(JSON.stringify({ cards: [{ created_at: "2026-07-01T00:00:00Z", expires_at: "2026-07-08T00:00:00Z" }] }), {
				status: 200,
			});
		};

		const snapshot = await collectCodexResetCardSnapshot({
			authPath,
			fetchImpl,
			now: new Date("2026-07-06T00:00:00Z"),
		});

		expect(authorization).toBe("Bearer test-token");
		expect(snapshot.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
		expect(snapshot.cards[0]?.expiresAt?.toISOString()).toBe("2026-07-08T00:00:00.000Z");
	});
});
