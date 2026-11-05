import type { ReactNode } from "react";
import { Fade } from "@/ui/motion/animated.tsx";
import { Feedback } from "@/ui/feedback.tsx";
import { useRemote } from "@/connection/use-remote.ts";
import { Button } from "@/ui/button.tsx";
import { SettingsSection } from "./settings-controls.tsx";

export function ConfigDocument<D>({ title, load, children }: { title: string; load: () => Promise<D>; children: (document: D) => ReactNode }) {
	const { result, refresh } = useRemote(load);
	if (result.state === "ready") return <Fade>{children(result.value)}</Fade>;
	return <SettingsSection title={title}>
		<Feedback compact message={result.state === "loading" ? "读取中…" : result.message} tone={result.state === "error" ? "error" : "info"}>
			{result.state === "error" && <Button variant="ghost" onClick={() => void refresh()}>重试</Button>}
		</Feedback>
	</SettingsSection>;
}
