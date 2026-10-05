import { memo } from "react";
import { Gauge, KeyRound, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Settings, Cpu } from "lucide-react";
import type { SidebarView } from "./gui-controls.ts";
import type { GuiAction } from "../../contract.ts";
import { SidebarWorkbench } from "../workspace/sidebar-workbench.tsx";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { WorkspacePicker } from "../workspace/workspace-picker.tsx";
import { SheetClose, SheetContent, SheetTitle } from "../components/ui/sheet";
import { Hint } from "../components/ui/tooltip";

export const Sidebar = memo(function Sidebar({ gui, collapsed, toggle, close }: { gui: SidebarView; collapsed: boolean; toggle: () => void; close: () => void }) {
	const act = (action: GuiAction) => { close(); void gui.send(action); };
	const open = (kind: "settings" | "auth" | "model") => { close(); gui.setPanel({ kind }); };
	const content = (compact: boolean, mobile: boolean) => <>
		<div className="sidebar-brand">
			<span className="brand" aria-hidden={compact}><span className="app-logo" aria-hidden="true" /><span>opi</span><small>workspace</small></span>
			{mobile ? <SheetClose asChild><IconButton label="关闭菜单"><PanelLeftClose /></IconButton></SheetClose>
				: <IconButton label={compact ? "展开侧栏" : "收起侧栏"} onClick={toggle} aria-expanded={!compact}>{compact ? <PanelLeftOpen /> : <PanelLeftClose />}</IconButton>}
		</div>
		<div className="sidebar-navigation">
			<div className="sidebar-expanded" inert={compact} aria-hidden={compact}>
				<SidebarWorkbench key={gui.cwd} gui={gui} close={close} />
			</div>
			{!mobile && <div className="sidebar-compact sidebar-scroll" inert={!compact} aria-hidden={!compact}>
				<div className="workspace-controls" data-compact="true">
					<WorkspacePicker gui={gui} close={close} compact />
					<Hint content="新建会话" side="right">
						<Button variant="outline" className="new-session" aria-label="新建会话" disabled={!gui.canNavigate}
							onClick={() => { void gui.send({ action: "new" }); close(); }}><Plus /></Button>
					</Hint>
				</div>
			</div>}
		</div>
		<div className="sidebar-footer">
			<IconButton label="设置" disabled={!gui.connected} onClick={() => open("settings")}><Settings /></IconButton>
			<IconButton label="认证" disabled={!gui.canSubmit} onClick={() => open("auth")}><KeyRound /></IconButton>
			<IconButton label="模型" disabled={!gui.canSubmit} onClick={() => open("model")}><Cpu /></IconButton>
			<IconButton label="套餐用量" disabled={!gui.canSubmit} onClick={() => act({ action: "view", view: "usage" })}><Gauge /></IconButton>
			<IconButton label="重载资源" disabled={!gui.canChangeSession} onClick={() => act({ action: "reload" })}><RefreshCw /></IconButton>
		</div>
	</>;
	return <>
		<aside className="sidebar" aria-label="侧栏" data-collapsed={collapsed}>{content(collapsed, false)}</aside>
		<SheetContent className="mobile-sidebar" aria-describedby={undefined}>
			<SheetTitle className="sr-only">工作空间导航</SheetTitle>{content(false, true)}
		</SheetContent>
	</>;
});
