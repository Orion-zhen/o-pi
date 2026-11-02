import type { ReactNode } from "react";
import { useRemote } from "@/connection/use-remote.ts";
import { Button } from "@/ui/button.tsx";
import { SettingsSection } from "./settings-controls.tsx";

export function ConfigDocument<D>({ title, load, children }: { title: string; load: () => Promise<D>; children: (document: D) => ReactNode }) {
	const { result, refresh } = useRemote(load);
	if (result.state === "ready") return children(result.value);
	return <SettingsSection title={title}>
		{result.state === "loading" ? <p role="status">读取中…</p> : <>
			<p role="alert">{result.message}</p><Button variant="ghost" onClick={() => void refresh()}>重试</Button>
		</>}
	</SettingsSection>;
}
