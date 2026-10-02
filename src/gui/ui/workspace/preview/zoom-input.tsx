import { useState } from "react";
import { Input } from "../../components/ui/input";

export function stepZoom(scale: number, direction: 1 | -1): number {
	const percent = Number((scale * 100).toFixed(2));
	return (direction === 1 ? Math.floor(percent / 5) + 1 : Math.ceil(percent / 5) - 1) * 5 / 100;
}

export function ZoomInput({ label, scale, min, max, disabled, onChange }: {
	label: string; scale: number; min: number; max: number; disabled?: boolean; onChange: (scale: number) => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const commit = () => {
		if (draft === null) return;
		const percent = Number(draft.trim().replace(/%$/, "").trim());
		if (Number.isFinite(percent) && percent > 0) onChange(Math.max(min, Math.min(max, percent / 100)));
		setDraft(null);
	};
	return <span className="media-zoom">
		<Input aria-label={label} type="text" inputMode="decimal" disabled={disabled}
			value={draft ?? Number((scale * 100).toFixed(2))}
			onFocus={(event) => event.currentTarget.select()}
			onChange={(event) => setDraft(event.currentTarget.value)} onBlur={commit}
			onKeyDown={(event) => {
				if (event.key === "Enter") { event.preventDefault(); commit(); }
				else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDraft(null); }
			}} />
		<span aria-hidden="true">%</span>
	</span>;
}
