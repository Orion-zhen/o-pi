import * as React from "react";
import { cn } from "./class-names.ts";
import { Check, Minus } from "lucide";
import { MorphIcon } from "morphicons/react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";

function Checkbox({ className, checked, ...props }: Omit<React.ComponentProps<typeof CheckboxPrimitive.Root>, "defaultChecked"> & { checked: boolean | "indeterminate" }) {
	return (
		<CheckboxPrimitive.Root
			data-slot="checkbox"
			checked={checked}
			className={cn(
				"peer size-[1.25em] shrink-0 rounded-[0.35em] border border-input bg-(--surface) transition-[border-color,box-shadow,background-color] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
				className,
			)}
			{...props}
		>
			<CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="grid place-content-center text-current transition-none">
				<MorphIcon icon={checked === "indeterminate" ? Minus : Check} spring="smooth" size="1em" />
			</CheckboxPrimitive.Indicator>
		</CheckboxPrimitive.Root>
	);
}

export { Checkbox };
