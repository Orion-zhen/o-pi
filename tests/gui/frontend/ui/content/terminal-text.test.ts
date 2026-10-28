import { expect, it } from "vitest";
import { clean } from "../../../../../src/gui/frontend/ui/content/format.ts";

it.each(["\x07", "\x1b\\"])("清理命令输出中的颜色、光标和窗口标题，保留正文与换行: %j", (end) => {
	const output = `\x1b]0;构建${end}\x1b[?25l\x1b[32m构建成功🙂\x1b[0m\n\x1b]0;测试${end}测试通过\n`;
	expect(clean(output)).toBe("构建成功🙂\n测试通过\n");
});

it("工具输出包含大量未闭合控制序列时仍可清理完整的颜色序列", () => {
	const incomplete = "\x1b]".repeat(30_000) + "\x1b[" + "1".repeat(30_000);
	expect(clean(incomplete + "\n\x1b[31m失败\x1b[0m")).toBe(incomplete + "\n失败");
});
