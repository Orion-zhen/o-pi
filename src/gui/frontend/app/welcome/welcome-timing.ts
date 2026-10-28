import { motionDuration, motionEase } from "@/ui/motion/transitions.ts";

export const sectionsDuration = motionDuration[4];
export const sectionFade = motionDuration[2];
interface ListTiming { row: number; singleRow: number; window: number; }

export const startupListTiming: ListTiming = { row: motionDuration[3], singleRow: motionDuration[5], window: 0.6 };
export const sessionListTiming: ListTiming = { row: motionDuration[4], singleRow: motionDuration[6], window: 0.8 };
// 各列表独立错峰，统一收尾等待最慢的一组。
export const listWindow = Math.max(startupListTiming.window, sessionListTiming.window);

export const welcomeLogoStart = 0.72;
export const welcomeLogoDuration = motionDuration[4];
export const welcomeContentStart = welcomeLogoStart + 0.12;
export const welcomeContentDuration = motionDuration[3];
export const welcomeComposerFadeDuration = motionDuration[1];
export const welcomeDuration = Math.max(
	welcomeLogoStart + welcomeLogoDuration,
	welcomeContentStart + welcomeContentDuration,
	welcomeContentStart + welcomeComposerFadeDuration,
);
export const welcomeStarterTransition = { duration: motionDuration[5], ease: motionEase };

// 捧起、停留、放下组成一个动作，停留时间和总时长不吸附到档位。
const offerEnter = motionDuration[7];
const offerHold = 0.8;
const offerDuration = offerEnter + offerHold + motionDuration[7];
export const welcomeIdle = {
	delayMs: 5_000,
	intervalMs: 18_000,
	offer: {
		duration: offerDuration,
		times: [0, offerEnter / offerDuration, (offerEnter + offerHold) / offerDuration, 1],
		ease: [0.3, 0, 0.3, 1] as const,
	},
};
