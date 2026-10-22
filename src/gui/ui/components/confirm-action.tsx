import { useState } from "react";
import { Check, Trash2 } from "lucide-react";
import { IconButton } from "./icon-button";
import { useConfirmation } from "./use-confirmation.ts";

export function ConfirmAction({ label, tooltip = "永久删除", disabled, confirm, allowShortcut = false }: {
	label: string; tooltip?: string; disabled: boolean; confirm: () => Promise<unknown>; allowShortcut?: boolean;
}) {
	const confirmation = useConfirmation();
	const armed = confirmation.armed !== undefined;
	const [pending, setPending] = useState(false);
	return <IconButton ref={confirmation.button} label={armed ? `确认${label}` : label} tooltip={armed ? "确认删除" : tooltip}
		className="row-action-button" disabled={disabled || pending} data-confirming={armed}
		onBlur={confirmation.cancel}
		onClick={(event) => {
			if (!armed && !(allowShortcut && (event.ctrlKey || event.metaKey))) { confirmation.arm(label); return; }
			confirmation.cancel();
			setPending(true);
			void confirm().finally(() => setPending(false));
		}}>{armed ? <Check /> : <Trash2 />}</IconButton>;
}
