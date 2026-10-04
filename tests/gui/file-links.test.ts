import { createElement } from "react";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { MarkdownText } from "../../src/gui/ui/content/content.tsx";
import { FileLinksContext, fileLinkPath } from "../../src/gui/ui/content/file-links.ts";
import { renderWithMemory } from "./render.ts";

function render(text: string) {
	return parseHTML(renderWithMemory(createElement(FileLinksContext, { value: { cwd: "/workspace", openFile() {} } },
		createElement(MarkdownText, { text })))).document;
}

describe("文件链接解析", () => {
	it.each([
		["src/main.ts", "src/main.ts"],
		["./src/../README.md", "README.md"],
		["Makefile", "Makefile"],
		["/workspace/src/main.ts", "src/main.ts"],
		["file:///workspace/src/main.ts", "src/main.ts"],
		["file://localhost/workspace/src/main.ts", "src/main.ts"],
		["src/main.ts#L42-L48", "src/main.ts"],
		["src/main.ts:42:3", "src/main.ts"],
		["README.md:42", "README.md"],
		["./Makefile:42", "Makefile"],
		["file:///workspace/src/main.ts:42#L42", "src/main.ts"],
		["README.md?raw=1#intro", "README.md"],
		["%E5%BC%95%E7%94%A8%20%E7%A9%BA%E6%A0%BC.md", "引用 空格.md"],
		["file:///workspace/%E5%BC%95%E7%94%A8%20%E7%A9%BA%E6%A0%BC.md", "引用 空格.md"],
		["src/a%23b%3Fc.ts", "src/a#b?c.ts"],
		["src/value%253A42", "src/value%3A42"],
		["src/value%3A42", "src/value:42"],
		["/workspace-copy/README.md", undefined],
		["../README.md", undefined],
		["src/../../README.md", undefined],
		["%2E%2E/secret.txt", undefined],
		["file:///workspace/../secret.txt", undefined],
		["file://server/workspace/README.md", undefined],
		["https://example.com/README.md", undefined],
		["mailto:test@example.com", undefined],
		["//example.com/README.md", undefined],
		["javascript:alert(1)", undefined],
		["javascript:42", undefined],
		["data:text/html,test", undefined],
		["vscode://file/workspace/README.md", undefined],
		["#L42", undefined],
		["?raw=1", undefined],
		["", undefined],
		[".", undefined],
		["/workspace", undefined],
		["bad%ZZ.md", undefined],
		["src/a%00.ts", undefined],
	])("%s -> %s", (href, expected) => {
		expect(fileLinkPath(href, "/workspace")).toBe(expected);
	});

	it("兼容根目录工作区以及 Windows 工作区的盘符和分隔符", () => {
		expect(fileLinkPath("/tmp/a.ts", "/")).toBe("tmp/a.ts");
		for (const href of ["src/main.ts", "C:/work/src/main.ts:42", "c:\\work\\src\\main.ts", "file:///C:/work/src/main.ts#L42"])
			expect(fileLinkPath(href, "C:\\work")).toBe("src/main.ts");
		expect(fileLinkPath("D:/work/src/main.ts", "C:\\work")).toBeUndefined();
		expect(fileLinkPath("../secret.txt", "C:\\work")).toBeUndefined();
	});
});

describe("聊天文件链接", () => {
	it("Markdown 文件链接渲染为可点击链接", () => {
		const doc = render("查看 [源文件](src/main.ts:42) 和 [本地文件](file:///workspace/README.md#L1)。");
		const links = [...doc.querySelectorAll("a")];
		expect(links.map((link) => link.textContent)).toEqual(["源文件", "本地文件"]);
		expect(links.map((link) => link.getAttribute("href"))).toEqual(["./src/main.ts", "./README.md"]);
		expect(links.map((link) => link.getAttribute("target"))).toEqual([null, null]);
	});

	it("引用式链接和中文空格路径保留标签并正确编码", () => {
		const doc = render("[说明][doc]\n\n[doc]: /workspace/%E5%BC%95%E7%94%A8%20%E7%A9%BA%E6%A0%BC.md");
		expect(doc.querySelector("a")?.textContent).toBe("说明");
		expect(doc.querySelector("a")?.getAttribute("title")).toBe("引用 空格.md");
		expect(doc.querySelector("a")?.getAttribute("href")).toBe("./%E5%BC%95%E7%94%A8%20%E7%A9%BA%E6%A0%BC.md");
	});

	it("网页、邮件链接继续在外部打开", () => {
		const doc = render("[网站](https://example.com) [邮件](mailto:test@example.com)");
		const links = [...doc.querySelectorAll("a")];
		expect(links.map((link) => link.getAttribute("href"))).toEqual(["https://example.com", "mailto:test@example.com"]);
		for (const link of links) {
			expect(link.getAttribute("target")).toBe("_blank");
			expect(link.getAttribute("rel")).toBe("noreferrer");
		}
	});

	it("越界路径、不安全协议和无工作区上下文的文件链接保持普通文本", () => {
		const doc = render("[外部文件](/secret.txt) [脚本](javascript:alert%281%29) [数字脚本](javascript:42) [数据](data:text/html,test)");
		expect(doc.querySelectorAll("a")).toHaveLength(0);
		expect(doc.querySelector("p")?.textContent).toContain("外部文件");
		const standalone = parseHTML(renderWithMemory(createElement(MarkdownText, { text: "[文件](file:///workspace/README.md)" }))).document;
		expect(standalone.querySelectorAll("a")).toHaveLength(0);
	});

	it("纯文本、行内代码和代码块不自动转为文件链接", () => {
		const doc = render("src/main.ts\n\n`src/main.ts`\n\n```text\n[文件](src/main.ts)\n```");
		expect(doc.querySelectorAll("a")).toHaveLength(0);
		expect(doc.querySelector("code")?.textContent).toBe("src/main.ts");
	});
});
