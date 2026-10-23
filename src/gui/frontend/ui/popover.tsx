import type * as React from "react";
import { Popover as Primitive } from "radix-ui";
import { cn } from "./class-names.ts";

export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;
export function PopoverContent({ className, align = "start", sideOffset = 4, ...props }: React.ComponentProps<typeof Primitive.Content>) {
	return <Primitive.Portal><Primitive.Content data-slot="popover-content" align={align} sideOffset={sideOffset} collisionPadding={8}
		className={cn("floating-surface z-50 min-w-0 max-w-(--radix-popover-content-available-width) max-h-(--radix-popover-content-available-height) overflow-auto rounded-lg border p-3 text-popover-foreground outline-none", className)} {...props} /></Primitive.Portal>;
}
