import type * as React from "react";
import { Popover as Primitive } from "radix-ui";
import { cn } from "@/lib/utils";

export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;
export function PopoverContent({ className, align = "start", sideOffset = 4, ...props }: React.ComponentProps<typeof Primitive.Content>) {
	return <Primitive.Portal><Primitive.Content data-slot="popover-content" align={align} sideOffset={sideOffset}
		className={cn("floating-surface z-50 rounded-lg border p-3 text-popover-foreground outline-none", className)} {...props} /></Primitive.Portal>;
}
