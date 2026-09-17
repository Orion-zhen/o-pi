import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthBrowser } from "../../src/gui/ui/oauth-browser.ts";

function browser() {
	const popup = {
		opener: {}, closed: false,
		document: { title: "", body: { textContent: "" } },
		location: { replace: vi.fn() }, close: vi.fn(),
	};
	const open = vi.fn(() => popup);
	vi.stubGlobal("window", { open });
	return { popup, open };
}
afterEach(() => vi.unstubAllGlobals());

describe("OAuth 浏览器导航", () => {
	it("在点击时预留窗口，收到 URL 后只导航一次，不关闭授权页面", async () => {
		const { popup, open } = browser();
		const oauth = new OAuthBrowser();
		oauth.prepare();
		expect(open).toHaveBeenCalledWith("about:blank", "_blank");
		expect(popup.opener).toBeNull();
		await oauth.open("https://example.com/oauth");
		await oauth.open("https://example.com/oauth");
		expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith("https://example.com/oauth");
		oauth.finish();
		expect(popup.close).not.toHaveBeenCalled();
	});

	it("需要选择登录方式时关闭空白窗口，在用户选择时重新预留", async () => {
		const { popup, open } = browser();
		const oauth = new OAuthBrowser();
		oauth.prepare();
		oauth.waitForInput();
		expect(popup.close).toHaveBeenCalledOnce();
		oauth.resume();
		expect(open).toHaveBeenCalledTimes(2);
		await oauth.open("https://example.com/device");
		expect(popup.location.replace).toHaveBeenCalledOnce();
	});

	it("取消时关闭尚未导航的窗口，迟到事件不打开浏览器", async () => {
		const { popup } = browser();
		const oauth = new OAuthBrowser();
		oauth.prepare();
		oauth.finish();
		await oauth.open("https://example.com/oauth");
		expect(popup.close).toHaveBeenCalledOnce();
		expect(popup.location.replace).not.toHaveBeenCalled();
	});

	it("被浏览器拦截时不在异步回调里再次创建弹窗", async () => {
		const open = vi.fn(() => null);
		vi.stubGlobal("window", { open });
		const oauth = new OAuthBrowser();
		oauth.prepare();
		await oauth.open("https://example.com/oauth");
		expect(open).toHaveBeenCalledOnce();
	});

	it("desktop 使用系统浏览器，不创建空白窗口", async () => {
		const openExternal = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("window", { opi: { openExternal } });
		const oauth = new OAuthBrowser();
		oauth.prepare();
		await oauth.open("https://example.com/oauth");
		expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/oauth");
		await expect(oauth.open("javascript:alert(1)")).rejects.toThrow("无效认证链接");
	});
});
