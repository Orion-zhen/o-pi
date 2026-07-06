import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderCodexResetCardError, renderCodexResetCards } from "../../src/codex-reset-card/render.js";
import { CodexResetCardError, type CodexResetCardSnapshot } from "../../src/codex-reset-card/types.js";

describe("codex reset card renderer", () => {
	it("宽屏渲染可读表格并限制宽度", () => {
		const lines = renderCodexResetCards(snapshot(), 100);
		const output = lines.join("\n");

		expect(output).toContain("Codex Reset Cards · 4 张 · 可用 1 · 已用 1 · 过期 1");
		expect(output).toContain("系统时区 Asia/Shanghai");
		expect(output).toContain("发放时间");
		expect(output).toContain("剩余 2天");
		expect(output).toContain("已用 2026-07-05 08:00:00");
		expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
	});

	it("80 列宽表不会截断使用情况末尾", () => {
		const data = snapshot();
		data.generatedAt = new Date("2026-07-06T00:00:00Z");
		data.cards = [
			{ issuedAt: new Date("2026-06-27T00:00:00Z"), expiresAt: new Date("2026-07-26T11:00:00Z"), usedAt: undefined },
		];
		const lines = renderCodexResetCards(data, 80);
		const output = lines.join("\n");

		expect(output).toContain("剩余 20天 11小时");
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	it("窄屏使用分块列表", () => {
		const lines = renderCodexResetCards(snapshot(), 44);
		const output = lines.join("\n");

		expect(output).toContain("#1 可用");
		expect(output).toContain("发放 2026-07-01 08:00:00");
		expect(lines.every((line) => visibleWidth(line) <= 44)).toBe(true);
	});

	it("错误渲染保持脱敏", () => {
		const lines = renderCodexResetCardError(
			new CodexResetCardError("unexpected_json_shape", "bad shape", { topLevelKeys: ["data", "request_id"] }),
			80,
		);
		const output = lines.join("\n");

		expect(output).toContain("查询失败");
		expect(output).toContain("接口 JSON 结构不符合预期");
		expect(output).toContain("顶层字段：data, request_id");
		expect(output).not.toContain("bad shape");
	});
});

function snapshot(): CodexResetCardSnapshot {
	return {
		timeZone: "Asia/Shanghai",
		generatedAt: new Date("2026-07-06T00:00:00Z"),
		cards: [
			{ issuedAt: new Date("2026-07-01T00:00:00Z"), expiresAt: new Date("2026-07-08T00:00:00Z"), usedAt: undefined },
			{ issuedAt: new Date("2026-07-01T00:00:00Z"), expiresAt: new Date("2026-07-04T00:00:00Z"), usedAt: undefined },
			{ issuedAt: new Date("2026-07-01T00:00:00Z"), expiresAt: new Date("2026-07-08T00:00:00Z"), usedAt: new Date("2026-07-05T00:00:00Z") },
			{ issuedAt: new Date("2026-07-07T00:00:00Z"), expiresAt: new Date("2026-07-09T00:00:00Z"), usedAt: undefined },
		],
	};
}
