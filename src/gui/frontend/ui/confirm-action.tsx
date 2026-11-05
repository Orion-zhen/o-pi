import { Check, Trash2 } from "lucide";
import { MorphIcon } from "morphicons/react";
import { IconButton } from "./icon-button.tsx";
import { useConfirmation } from "./use-confirmation.ts";

export function ConfirmAction({ label, tooltip = "永久删除", disabled, confirm, allowShortcut = false }: {
	label: string; tooltip?: string; disabled: boolean; confirm: () => void; allowShortcut?: boolean;
}) {
	const confirmation = useConfirmation();
	const armed = confirmation.armed !== undefined;
	return <IconButton ref={confirmation.button} label={armed ? `确认${label}` : label} tooltip={armed ? "确认删除" : tooltip}
		className="row-action-button" disabled={disabled} data-confirming={armed}
		onBlur={confirmation.cancel}
		onClick={(event) => {
			if (!armed && !(allowShortcut && (event.ctrlKey || event.metaKey))) { confirmation.arm(label); return; }
			confirmation.cancel();
			confirm();
		}}><MorphIcon icon={armed ? Check : Trash2} spring="smooth" size="1em" /></IconButton>;
}
