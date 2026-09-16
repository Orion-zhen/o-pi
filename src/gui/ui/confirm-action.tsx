import { useEffect, useState } from "react";
import { Check, Trash2 } from "lucide-react";
import { IconButton } from "./components/icon-button";

export function ConfirmAction({ label, hint, disabled, confirm, allowCtrl = false }: {
	label: string; hint: string; disabled: boolean; confirm: () => Promise<unknown>; allowCtrl?: boolean;
}) {
	const [armed, setArmed] = useState(false);
	const [pending, setPending] = useState(false);
	useEffect(() => {
		if (!armed) return;
		const cancel = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			setArmed(false);
		};
		window.addEventListener("keydown", cancel, true);
		return () => window.removeEventListener("keydown", cancel, true);
	}, [armed]);
	return <IconButton label={armed ? `确认${label}` : label} title={armed ? `再次点击确认。${hint}` : hint}
		className="row-action-button" disabled={disabled || pending} data-confirming={armed}
		onBlur={() => setArmed(false)}
		onClick={(event) => {
			if (!armed && !(allowCtrl && event.ctrlKey)) { setArmed(true); return; }
			setArmed(false);
			setPending(true);
			void confirm().finally(() => setPending(false));
		}}>{armed ? <Check /> : <Trash2 />}</IconButton>;
}
