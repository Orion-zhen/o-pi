import type { ComponentProps } from "react";
import { X } from "lucide-react";
import { cn } from "../lib/utils";
import { IconButton } from "./icon-button";
import { Input } from "./ui/input";

export function SearchInput({ value, onValueChange, className, disabled, readOnly, ...props }: Omit<ComponentProps<typeof Input>, "value" | "onChange"> & {
	value: string; onValueChange: (value: string) => void;
}) {
	return <div data-slot="search-input" className="relative w-full min-w-0">
		<Input {...props} className={cn("pe-[2.5em]", className)} value={value} disabled={disabled} readOnly={readOnly}
			onChange={(event) => onValueChange(event.target.value)} />
		{value.length > 0 && <IconButton label="清空输入" size="icon-xs" disabled={disabled || readOnly}
			className="absolute end-[0.35em] top-1/2 -translate-y-1/2 text-muted-foreground"
			onMouseDown={(event) => event.preventDefault()}
			onClick={(event) => {
				onValueChange("");
				event.currentTarget.parentElement?.querySelector("input")?.focus();
			}}><X aria-hidden="true" /></IconButton>}
	</div>;
}
