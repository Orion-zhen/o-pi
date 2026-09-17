import { createContext, useContext, type ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { Dialog as SheetPrimitive } from "radix-ui";

const Expanded = createContext(false);

export function Sheet({ open, ...props }: Omit<ComponentProps<typeof SheetPrimitive.Root>, "defaultOpen"> & { open: boolean }) {
	return <Expanded value={open}><SheetPrimitive.Root open={open} {...props} /></Expanded>;
}
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetClose = SheetPrimitive.Close;

export function SheetContent({ className, children, ...props }: ComponentProps<typeof SheetPrimitive.Content>) {
	const open = useContext(Expanded);
	return <SheetPrimitive.Portal container={document.getElementById("root")}>
		<SheetPrimitive.Overlay data-slot="sheet-overlay" className="modal-layer sheet-layer bg-(--overlay) backdrop-blur-xs">
			<SheetPrimitive.Content data-slot="sheet-content"
				className={cn("floating-surface flex min-h-0 min-w-0 basis-3/4 flex-col gap-4 border-r outline-none", className)}
				{...props} inert={!open} aria-hidden={!open}>{children}</SheetPrimitive.Content>
		</SheetPrimitive.Overlay>
	</SheetPrimitive.Portal>;
}

export function SheetTitle({ className, ...props }: ComponentProps<typeof SheetPrimitive.Title>) {
	return <SheetPrimitive.Title data-slot="sheet-title" className={cn("font-semibold text-foreground", className)} {...props} />;
}
