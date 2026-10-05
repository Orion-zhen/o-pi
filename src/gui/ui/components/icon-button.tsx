import type { ComponentProps } from "react";
import { Button } from "./ui/button";
import { Hint } from "./ui/tooltip";

export function IconButton({ label, tooltip = label, children, ...props }: Omit<ComponentProps<typeof Button>, "title"> & { label: string; tooltip?: string }) {
	return <Hint content={tooltip}>
		<Button type="button" variant="ghost" size="icon" aria-label={label} {...props}>
			{children}
		</Button>
	</Hint>;
}
