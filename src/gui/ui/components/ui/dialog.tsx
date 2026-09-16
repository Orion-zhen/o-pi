import type * as React from "react";
import { cn } from "@/lib/utils";
import { Dialog as DialogPrimitive } from "radix-ui";

export const Dialog = DialogPrimitive.Root;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
	return <DialogPrimitive.Portal container={document.getElementById("root")}>
		<DialogPrimitive.Overlay data-slot="dialog-overlay" className="modal-layer bg-(--overlay) backdrop-blur-xs data-[state=open]:animate-in data-[state=open]:fade-in-0">
			<DialogPrimitive.Content data-slot="dialog-content"
				className={cn("modal-content floating-surface gap-4 rounded-xl border p-6 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0", className)}
				{...props}>{children}</DialogPrimitive.Content>
		</DialogPrimitive.Overlay>
	</DialogPrimitive.Portal>;
}

export function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="dialog-header" className={cn("flex flex-col gap-2 text-center sm:text-left", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
	return <DialogPrimitive.Title data-slot="dialog-title" className={cn("text-lg leading-normal font-medium", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
	return <DialogPrimitive.Description data-slot="dialog-description" className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
