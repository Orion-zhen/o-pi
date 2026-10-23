import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide";
import { MorphIcon } from "morphicons/react";
import { TextMorph } from "../motion/text-morph.tsx";
import { Hint } from "../tooltip.tsx";

export function CodeToolbar({ text, label, children }: { text: string; label: string; children?: ReactNode }) {
	const [copied, setCopied] = useState<string | null>(null);
	const [error, setError] = useState(false);
	const complete = copied === text && !error;
	return <div className="code-toolbar">
		<Hint content={label}><span>{label}</span></Hint>
		<div className="code-toolbar-actions">
			{children}
			<button type="button" aria-label={`复制${label}`} onClick={async () => {
				try {
					await navigator.clipboard.writeText(text);
					setCopied(text);
					setError(false);
				} catch {
					setError(true);
				}
			}}>
				<MorphIcon icon={complete ? Check : Copy} spring="smooth" size="1em" />
				<TextMorph>{error ? "复制失败" : complete ? "已复制" : "复制"}</TextMorph>
			</button>
		</div>
	</div>;
}
