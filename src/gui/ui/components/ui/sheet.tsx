import type * as React from "react";
import { cn } from "@/lib/utils";
import { Dialog as SheetPrimitive } from "radix-ui";

export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetClose = SheetPrimitive.Close;

export function SheetContent({ className, children, ...props }: React.ComponentProps<typeof SheetPrimitive.Content>) {
	return <SheetPrimitive.Portal container={document.getElementById("root")}>
		<SheetPrimitive.Overlay data-slot="sheet-overlay" className="modal-layer sheet-layer bg-(--overlay) backdrop-blur-xs data-[state=open]:animate-in data-[state=open]:fade-in-0">
			<SheetPrimitive.Content data-slot="sheet-content"
				className={cn("floating-surface flex min-h-0 min-w-0 basis-3/4 flex-col gap-4 border-r outline-none data-[state=open]:animate-in data-[state=open]:slide-in-from-left", className)}
				{...props}>{children}</SheetPrimitive.Content>
		</SheetPrimitive.Overlay>
	</SheetPrimitive.Portal>;
}

export function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
	return <SheetPrimitive.Title data-slot="sheet-title" className={cn("font-semibold text-foreground", className)} {...props} />;
}
