import type * as React from "react";
import { cn } from "@/lib/utils";
import { DropdownMenu as Menu } from "radix-ui";

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;

export function DropdownMenuContent({ className, sideOffset = 4, ...props }: React.ComponentProps<typeof Menu.Content>) {
	return <Menu.Portal>
		<Menu.Content data-slot="dropdown-menu-content" sideOffset={sideOffset}
			className={cn("floating-surface z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[12em] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border p-2 text-popover-foreground", className)}
			{...props} />
	</Menu.Portal>;
}

export function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof Menu.Item>) {
	return <Menu.Item data-slot="dropdown-menu-item"
		className={cn("flex cursor-default items-center gap-2 rounded-sm px-2 py-[0.625em] text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground", className)}
		{...props} />;
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof Menu.Label>) {
	return <Menu.Label data-slot="dropdown-menu-label" className={cn("px-2 py-1.5 text-sm font-medium", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof Menu.Separator>) {
	return <Menu.Separator data-slot="dropdown-menu-separator" className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}
