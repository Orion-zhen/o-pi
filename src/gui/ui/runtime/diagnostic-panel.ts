import { diagnosticKinds, diagnosticScopes, diagnosticText, errorSummary, type GuiDiagnostic } from "../../diagnostics.ts";

/** 位于 React 根节点之外，组件树卸载后仍能阅读和复制。 */
export function showDiagnostic(value: GuiDiagnostic): (status: string, detail?: string) => void {
	let panel = document.getElementById("gui-diagnostics");
	if (!panel) {
		panel = document.createElement("section");
		panel.id = "gui-diagnostics";
		panel.setAttribute("aria-label", "界面异常诊断");
		const heading = document.createElement("h2");
		heading.textContent = "界面发生异常";
		const hint = document.createElement("p");
		hint.textContent = "后台任务可能仍在运行，请勿重复发送。保留最近 10 条异常，分享诊断前请检查敏感信息。";
		panel.append(heading, hint);
		document.body.prepend(panel);
	}
	if (value.kind === "react-root" || value.kind === "startup") panel.dataset.fatal = "true";
	const record = document.createElement("article");
	const heading = document.createElement("h3");
	heading.textContent = `${diagnosticKinds[value.kind]} / ${diagnosticScopes[value.scope]}`;
	const message = document.createElement("p");
	message.className = "diagnostic-message";
	message.setAttribute("role", "alert");
	message.textContent = errorSummary(value.message);
	const detail = document.createElement("details");
	const summary = document.createElement("summary");
	summary.textContent = "错误详情";
	const pre = document.createElement("pre");
	const receipt = document.createElement("p");
	receipt.textContent = "正在记录诊断…";
	let text = diagnosticText(value);
	pre.textContent = text;
	const copy = document.createElement("button");
	copy.type = "button";
	copy.textContent = "复制诊断信息";
	copy.addEventListener("click", () => {
		void (async () => {
			try {
				await navigator.clipboard.writeText(text);
				copy.textContent = "已复制诊断信息";
			} catch {
				copy.textContent = "复制失败，请展开详情手动选择诊断文本";
			}
		})();
	});
	detail.append(summary, pre);
	record.append(heading, message, copy, receipt, detail);
	panel.append(record);
	const records = panel.querySelectorAll("article");
	if (records.length > 10) records.item(0).remove();
	return (status, extra = status) => {
		receipt.textContent = status;
		text = `${diagnosticText(value)}\n${extra}`;
		pre.textContent = text;
	};
}
