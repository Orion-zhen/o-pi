import type { ComponentProps } from "react";
import { X, type LucideIcon } from "lucide-react";
import { IconButton } from "./icon-button.tsx";
import { Input } from "./input.tsx";
import "./search-input.css";

export function SearchInput({ value, onValueChange, className, disabled, readOnly, icon: Icon, ...props }: Omit<ComponentProps<typeof Input>, "value" | "onChange"> & {
	value: string; onValueChange: (value: string) => void; icon?: LucideIcon;
}) {
	return <div data-slot="search-input">
		{Icon && <Icon aria-hidden="true" />}
		<Input {...props} className={className} value={value} disabled={disabled} readOnly={readOnly}
			onChange={(event) => onValueChange(event.target.value)} />
		{value.length > 0 && <IconButton label="清空输入" size="icon-xs" disabled={disabled || readOnly}
			className="text-muted-foreground"
			onMouseDown={(event) => event.preventDefault()}
			onClick={(event) => {
				onValueChange("");
				event.currentTarget.parentElement?.querySelector("input")?.focus();
			}}><X aria-hidden="true" /></IconButton>}
	</div>;
}
