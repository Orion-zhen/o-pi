import type * as React from "react";
import { Popover as Primitive } from "radix-ui";
import { cn } from "@/lib/utils";

export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;
export function PopoverContent({ className, align = "start", sideOffset = 4, ...props }: React.ComponentProps<typeof Primitive.Content>) {
	return <Primitive.Portal><Primitive.Content align={align} sideOffset={sideOffset}
		className={cn("z-50 rounded-md border bg-popover p-3 text-popover-foreground shadow-md outline-none", className)} {...props} /></Primitive.Portal>;
}
