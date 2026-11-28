import { ApprovalEnvironment } from "./approval-environment.tsx";
import { memo, useState } from "react";
import type { GuiShellApproval } from "../../../../shared/protocol/state.ts";
import { SyntaxHighlighter } from "@/ui/content/code-highlight.ts";
import "./shell-approval.css";

function ShellCommand({ shell, command, label }: { shell: GuiShellApproval["shell"]; command: string; label: string }) {
	return <figure className="approval-command-code">
		<figcaption>{label}</figcaption>
		<div className="code-block"><SyntaxHighlighter language={shell} useInlineStyles={false} wrapLongLines>{command}</SyntaxHighlighter></div>
	</figure>;
}

const actionNames: Record<GuiShellApproval["items"][number]["action"], string> = {
	execute: "确认原因", create_directory: "创建目录", write_redirect: "重定向写入", write_file: "写入文件", edit_file: "修改文件", fetch_url: "访问地址",
};

export const ShellApproval = memo(function ShellApproval({ approval: masked, reveal }: { approval: GuiShellApproval; reveal: () => Promise<GuiShellApproval> }) {
	const [revealed, setRevealed] = useState<GuiShellApproval>();
	const approval = revealed ?? masked;
	return <section className="approval-details" aria-label="调用详情" tabIndex={0}>
		<p className="approval-cwd">工作目录　<code>{approval.cwd}</code></p>
		<ul className="approval-findings" aria-label="需要确认的操作">{approval.items.map((item, i) => <li key={i}>
			<p className="approval-reason"><strong>{actionNames[item.action]}</strong>　{item.reason}</p>
			{item.kind === "command" ? item.target !== approval.command && <ShellCommand shell={approval.shell} command={item.target} label="需确认的子命令" /> : <code className="approval-target">{item.target}</code>}
		</li>)}</ul>
		<ShellCommand shell={approval.shell} command={approval.command} label="完整命令" />
		{approval.environment.length > 0 && <ApprovalEnvironment variables={approval.environment} canReveal={masked.environment.some(entry => entry.kind === "hidden")}
			reveal={reveal} revealed={Boolean(revealed)} change={setRevealed} />}
	</section>;
});
