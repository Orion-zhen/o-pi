import { useEffect, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import type { Query, WorkspaceQuery } from "../../contract.ts";
import type { GuiLspServer, GuiLspServers } from "../../lsp.ts";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { SettingsSection } from "./settings-controls.tsx";
import "./lsp-servers.css";

export function LspServers({ cwd, query, connected, active }: {
	cwd: string | undefined; query: Query<WorkspaceQuery>; connected: boolean; active: boolean;
}) {
	const [result, setResult] = useState<GuiLspServers>();
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		if (!cwd || !connected || !active) return;
		let current = true;
		setLoading(true);
		setError("");
		void query({ query: "lspServers", cwd }).then((value) => {
			if (!current) return;
			setResult(value); setLoading(false);
		}, (error: unknown) => {
			if (!current) return;
			setResult(undefined); setError(error instanceof Error ? error.message : String(error)); setLoading(false);
		});
		return () => { current = false; };
	}, [cwd, query, connected, active, revision]);
	return <SettingsSection title="LSP 服务器" actions={<Button variant="ghost" size="sm" disabled={!cwd || !connected || loading} onClick={() => setRevision((value) => value + 1)}>
		<RefreshCw aria-hidden="true" />刷新
	</Button>}>
		{!cwd ? <p className="settings-empty">未选择工作区</p> : !connected ? <p role="status">连接已断开，恢复后重新检查命令。</p> : <>
			<p className="settings-description">当前工作区：<code>{cwd}</code></p>
			{loading && <p role="status">检查中…</p>}
			{error && <p role="alert">{error}</p>}
			{result && <>
				<p className="settings-description">配置来源：<code>{result.path}</code></p>
				{result.servers.length === 0 && <p className="settings-empty">未配置 LSP 服务器</p>}
				<div className="lsp-server-list" aria-busy={loading}>{result.servers.map((server) => <ServerRow key={server.id} server={server} />)}</div>
			</>}
		</>}
	</SettingsSection>;
}

function ServerRow({ server }: { server: GuiLspServer }) {
	const transport = server.transport;
	const availability = transport.type === "tcp" ? "tcp" : transport.executable === null ? "missing" : "found";
	return <Collapsible className="lsp-server" asChild><article aria-label={`LSP 服务器 ${server.id}`}>
		<CollapsibleTrigger asChild><Button variant="ghost" className="lsp-server-summary disclosure-trigger" aria-label={`查看 ${server.id} 详情`}>
			<ChevronRight className="disclosure-chevron" aria-hidden="true" />
			<span className="lsp-server-name"><strong>{server.id}</strong><span>{server.languages.join(", ")}</span></span>
			<span className="lsp-server-availability" data-availability={availability}>{availability === "tcp" ? "TCP" : availability === "found" ? "可用" : "不可用"}</span>
		</Button></CollapsibleTrigger>
		<CollapsibleContent lazy><div className="lsp-server-details">
			<dl><dt>{transport.type === "stdio" ? "启动命令" : "TCP 地址"}</dt><dd><code>{transport.type === "stdio"
				? JSON.stringify([transport.command, ...transport.args])
				: `${transport.host.includes(":") ? `[${transport.host}]` : transport.host}:${transport.port}`}</code></dd>
				{transport.type === "stdio" && transport.executable !== null && <><dt>可执行文件</dt><dd><code>{transport.executable}</code></dd></>}
			</dl>
			{transport.type === "stdio" && transport.executable === null && <p className="settings-description">请确认命令已安装，且 GUI 后端能通过 PATH 或配置路径找到它。</p>}
		</div></CollapsibleContent>
	</article></Collapsible>;
}
