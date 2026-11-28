import type { GuiApprovalContent } from "../../../../shared/protocol/state.ts";

export function ToolApproval({ approval, reason }: Extract<GuiApprovalContent, { kind: "toolApproval" }>) {
	return <section className="approval-details" aria-label="调用详情" tabIndex={0}>
		<code className="approval-target">{approval.tool === "webfetch" ? approval.detail.url : approval.detail.path}</code>
		<p className="approval-cwd">工作目录　<code>{approval.cwd}</code></p>
		<p className="approval-reason">{reason}</p>
		{approval.tool === "write" ? <pre>{approval.detail.content}</pre>
			: approval.tool === "edit" ? approval.detail.edits.map((edit, i) => <section key={i} aria-label={`替换 ${i + 1}`}>
				{edit.replace_all && <small>替换所有匹配项</small>}
				<pre className="text-(--git-deleted)">{edit.old.split("\n").map(line => `- ${line}`).join("\n")}</pre>
				<pre className="text-(--git-added)">{edit.new.split("\n").map(line => `+ ${line}`).join("\n")}</pre>
			</section>) : <p>网络范围：{{ public: "公网", private: "私网", loopback: "本机回环" }[approval.detail.scope]}<br />解析地址：<code>{approval.detail.addresses.join(", ")}</code></p>}
	</section>;
}
