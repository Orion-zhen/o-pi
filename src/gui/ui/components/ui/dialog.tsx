import type * as React from "react";
import { motion, useIsPresent } from "motion/react";
import { fade, settle } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Dialog as DialogPrimitive } from "radix-ui";

export function Dialog({ open, ...props }: Omit<React.ComponentProps<typeof DialogPrimitive.Root>, "defaultOpen"> & { open: boolean }) {
	const present = useIsPresent();
	return <DialogPrimitive.Root {...props} open={present && open} />;
}
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
	const present = useIsPresent();
	return <DialogPrimitive.Portal forceMount container={document.getElementById("root")}>
		<DialogPrimitive.Overlay asChild>
			<motion.div {...fade} data-slot="dialog-overlay" className="modal-layer bg-(--overlay) backdrop-blur-xs">
				<DialogPrimitive.Content asChild {...props}>
					<motion.div data-slot="dialog-content" inert={!present} aria-hidden={!present}
						initial={{ y: 8, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 4, scale: 0.98 }} transition={settle}
						className={cn("modal-content floating-surface gap-4 rounded-xl border p-6 outline-none", className)}>{children}</motion.div>
				</DialogPrimitive.Content>
			</motion.div>
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
