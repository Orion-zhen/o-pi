import { useLayoutEffect } from "react";
import { motion, useSpring, useTransform } from "motion/react";

const format = (value: number) => Math.round(value).toLocaleString("zh-CN");

export function AnimatedNumber({ value }: { value: number }) {
	const spring = useSpring(value, { stiffness: 300, damping: 35 });
	const display = useTransform(spring, format);
	useLayoutEffect(() => { spring.set(value); }, [spring, value]);
	return <span className="animated-number">
		<span className="animated-number-target">{format(value)}</span>
		<motion.span aria-hidden="true">{display}</motion.span>
	</span>;
}
