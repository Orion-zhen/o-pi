import type { ComponentProps } from "react";
import { X } from "lucide-react";
import { IconButton } from "./icon-button";
import { Input } from "./ui/input";
import "./search-input.css";

export function SearchInput({ value, onValueChange, className, disabled, readOnly, ...props }: Omit<ComponentProps<typeof Input>, "value" | "onChange"> & {
	value: string; onValueChange: (value: string) => void;
}) {
	return <div data-slot="search-input">
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
