import { createContext, useContext, type ComponentProps } from "react";
import { ToggleGroup as Primitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const toggleVariants = cva(
	"inline-flex items-center justify-center gap-[0.5em] rounded-md border border-transparent text-sm leading-normal font-medium transition-[background-color,color,border-color,box-shadow] outline-none hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-45 data-[state=on]:border-primary/40 data-[state=on]:bg-(--selected) data-[state=on]:text-(--selected-foreground) [&_svg]:pointer-events-none [&_svg]:size-[1.15em] [&_svg]:shrink-0",
	{
		variants: {
			variant: { default: "bg-transparent", outline: "border-input bg-(--surface)" },
			size: {
				default: "px-[0.9em] py-[0.6em]",
				sm: "px-[0.75em] py-[0.45em] text-[length:var(--text-small)]",
				lg: "px-[1.25em] py-[0.75em]",
			},
		},
		defaultVariants: { variant: "default", size: "default" },
	},
);

const ToggleGroupContext = createContext<VariantProps<typeof toggleVariants>>({ variant: "default", size: "default" });

export function ToggleGroup({ className, variant, size, children, ...props }: ComponentProps<typeof Primitive.Root> & VariantProps<typeof toggleVariants>) {
	return <Primitive.Root data-slot="toggle-group" className={cn("flex items-center justify-center gap-1", className)} {...props}>
		<ToggleGroupContext value={{ variant, size }}>{children}</ToggleGroupContext>
	</Primitive.Root>;
}

export function ToggleGroupItem({ className, variant, size, ...props }: ComponentProps<typeof Primitive.Item> & VariantProps<typeof toggleVariants>) {
	const context = useContext(ToggleGroupContext);
	return <Primitive.Item data-slot="toggle-group-item"
		className={cn(toggleVariants({ variant: variant ?? context.variant, size: size ?? context.size }), className)} {...props} />;
}
