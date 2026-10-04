import type * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
	return <SwitchPrimitive.Root data-slot="switch" className={cn(
		"inline-flex h-[1.5em] w-[2.75em] shrink-0 items-center rounded-full bg-input p-[0.125em] outline-none transition-[background-color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-45 data-[state=checked]:bg-primary",
		className,
	)} {...props}>
		<SwitchPrimitive.Thumb data-slot="switch-thumb" className="pointer-events-none block size-[1.25em] rounded-full bg-background shadow-xs transition-transform duration-200 data-[state=checked]:translate-x-[1.25em] data-[state=unchecked]:translate-x-0" />
	</SwitchPrimitive.Root>;
}
