import { useEffect, useState } from "react";
import type { GuiChangelog } from "../contract.ts";
import { Disclosure } from "./components/disclosure";
import { MarkdownText } from "./content.tsx";
import "./startup-changelog.css";

export function StartupChangelog({ value, shown }: { value: GuiChangelog; shown: () => void }) {
	const [open, setOpen] = useState(!value.collapsed);
	useEffect(() => {
		const acknowledge = () => { if (document.visibilityState === "visible") shown(); };
		acknowledge();
		document.addEventListener("visibilitychange", acknowledge);
		return () => document.removeEventListener("visibilitychange", acknowledge);
	}, [shown]);
	return <section className="startup-changelog" aria-label="Pi 更新日志">
		<Disclosure open={open} onOpenChange={setOpen} summary={<>
			<span>Pi 已更新至 v{value.version}</span>
			<span className="changelog-toggle">{open ? "收起更新日志" : "展开更新日志"}</span>
		</>} lazy>
			<div className="message changelog-body"><MarkdownText text={value.markdown} /></div>
		</Disclosure>
	</section>;
}
