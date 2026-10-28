import { lazy, Suspense, useEffect, useState, type ComponentProps, type Ref } from "react";
import { PanelDialog } from "@/ui/panel-dialog.tsx";
import { Button } from "@/ui/button.tsx";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/ui/dialog.tsx";

const Settings = lazy(() => import("./panel.tsx").then((module) => ({ default: module.Settings })));

type Props = Omit<ComponentProps<typeof Settings>, "onDirty"> & { ref: Ref<HTMLDivElement>; close: () => void; restoreFocus: () => void };

export function SettingsDialog({ ref, close, restoreFocus, ...settings }: Props) {
	const [dirty, setDirty] = useState(false);
	const [confirmClose, setConfirmClose] = useState(false);
	useEffect(() => {
		if (!dirty) return;
		const preventClose = (event: BeforeUnloadEvent) => { event.preventDefault(); };
		window.addEventListener("beforeunload", preventClose);
		return () => window.removeEventListener("beforeunload", preventClose);
	}, [dirty]);
	return <>
		<PanelDialog ref={ref} title="设置" close={() => dirty ? setConfirmClose(true) : close()} restoreFocus={restoreFocus}>
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
