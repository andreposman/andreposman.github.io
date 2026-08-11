// Site-wide smooth scroll (Lenis) wired into GSAP ScrollTrigger via a
// scrollerProxy, so ScrollTrigger reads/writes scroll position through Lenis
// instead of the native scrollTop.

import Lenis from 'lenis';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

export function initSmoothScroll() {
	gsap.registerPlugin(ScrollTrigger);

	const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	const lenis = new Lenis({
		duration: reduceMotion ? 0 : 1.1,
		smoothWheel: !reduceMotion,
	});

	ScrollTrigger.scrollerProxy(document.body, {
		scrollTop(value) {
			if (arguments.length) {
				lenis.scrollTo(value as number, { immediate: true });
			}
			return lenis.scroll;
		},
		getBoundingClientRect() {
			return { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
		},
	});

	// Keep ScrollTrigger's calculations in lockstep with Lenis's own raf loop.
	lenis.on('scroll', ScrollTrigger.update);

	gsap.ticker.add((time) => {
		lenis.raf(time * 1000);
	});
	gsap.ticker.lagSmoothing(0);

	ScrollTrigger.addEventListener('refresh', () => lenis.resize());
	ScrollTrigger.refresh();

	return lenis;
}
