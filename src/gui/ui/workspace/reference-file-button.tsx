import { AtSign } from "lucide-react";
import { motion, useAnimationControls } from "motion/react";
import { IconButton } from "../components/icon-button";
import { feedback } from "../lib/motion";

export function ReferenceFileButton({ path, referenceFile, direction, disabled = false }: {
	path: string; referenceFile: (path: string) => boolean; direction: -1 | 1; disabled?: boolean;
}) {
	const animation = useAnimationControls();
	return <IconButton label={direction === 1 ? `引用路径 ${path}` : "引用文件"} tooltip={direction === 1 ? "引用路径" : "引用文件"}
		className={direction === 1 ? "row-action-button" : undefined} size={direction === 1 ? "icon" : "icon-sm"} disabled={disabled}
		onClick={() => {
			if (referenceFile(path)) void animation.start({ x: [0, direction * 4, 0], y: [0, 3, 0], opacity: [1, 0.55, 1], transition: feedback });
		}}>
		<motion.span className="inline-flex" animate={animation}><AtSign className={direction === 1 ? "size-[1.25em]" : undefined} /></motion.span>
	</IconButton>;
}
