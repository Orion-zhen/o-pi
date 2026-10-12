import { lazy, Suspense, useEffect, useState, type ComponentProps, type Ref } from "react";
import { PanelDialog } from "../components/panel-dialog";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "../components/ui/dialog";

const Settings = lazy(() => import("./settings-panel.tsx").then((module) => ({ default: module.Settings })));

type Props = Omit<ComponentProps<typeof Settings>, "onDirty"> & { ref: Ref<HTMLDivElement>; close: () => void };

export function SettingsDialog({ ref, close, ...settings }: Props) {
	const [dirty, setDirty] = useState(false);
	const [confirmClose, setConfirmClose] = useState(false);
	useEffect(() => {
		if (!dirty) return;
		const preventClose = (event: BeforeUnloadEvent) => { event.preventDefault(); };
		window.addEventListener("beforeunload", preventClose);
		return () => window.removeEventListener("beforeunload", preventClose);
	}, [dirty]);
	return <>
		<PanelDialog ref={ref} title="设置" close={() => dirty ? setConfirmClose(true) : close()} restoreFocus={settings.restoreFocus}>
			<Suspense fallback={<p role="status">正在加载设置…</p>}>
				<Settings {...settings} onDirty={setDirty} />
			</Suspense>
		</PanelDialog>
		{confirmClose && <Dialog open onOpenChange={setConfirmClose}>
			<DialogContent><DialogTitle>放弃未保存的设置？</DialogTitle>
				<DialogDescription>各分类中的未保存修改都会丢失。</DialogDescription>
				<div className="toolbar"><Button variant="outline" onClick={() => setConfirmClose(false)}>继续编辑</Button>
					<Button variant="destructive" onClick={() => { setDirty(false); close(); }}>放弃并关闭</Button></div>
			</DialogContent>
		</Dialog>}
	</>;
}
