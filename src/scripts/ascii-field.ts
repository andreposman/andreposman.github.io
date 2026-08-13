// Full-viewport ASCII density-field background (Codex-login-style effect):
// a grid of monospace characters whose density (from a faint dot to a solid
// block) is driven by a slowly evolving 2D value-noise field, blended with a
// smooth proximity boost around the mouse. Rendered on canvas via fillText —
// not DOM spans — since a ~16px grid over a full hero viewport is thousands
// of cells, too many nodes for layout to stay cheap.
//
// This is an ambient noise cloud, not a photo/portrait reconstruction: we
// don't have a source image to convert, so the "soft grayscale shape" from
// the reference is approximated with organic drifting noise instead.

const RAMP = ' .:-=+*#%@';
const RAMP_MAX = RAMP.length - 1; // 9

const BASE_CELL = 16; // px, matches the reference's monospace grid
const MAX_CELLS = 8000; // perf budget for a full hero-viewport grid

const NOISE_FREQ = 0.026; // spatial frequency, in grid-cell units — low, so the
// field forms a handful of large soft blobs (like the reference's cloud),
// not lots of small busy clusters
const NOISE_TIME_SPEED = 0.03; // per second, drift along the noise's time axis
const MOUSE_RADIUS = 260; // px, proximity-boost falloff radius
const MOUSE_BOOST_STRENGTH = 0.95; // how strongly the pointer overrides the
// base level at its center (blend toward RAMP_MAX, not an additive nudge —
// additive got clamped away wherever the base noise was already dense,
// making the pointer effect nearly invisible)
const LERP_RATE = 6; // per second, how fast a cell chases its target density

const REDRAW_INTERVAL = 1000 / 30; // throttle noise-step + redraw to ~30fps


// "ANDRE POSMAN" click easter egg: a cached coverage mask (built from an
// offscreen canvas, one pixel per grid cell) says which cells sit under a
// letter stroke. On click, those cells' target density blends toward
// RAMP_MAX with a 0→1→0 envelope over this timeline, layered into the
// existing targetLevel()/lerp pipeline so the transition stays smooth.
// Two lines rather than one: at this grid's resolution (tens of cells
// across, not hundreds) a single "ANDRE POSMAN" line only gets ~6 cells per
// character — too coarse to read as letters, just a blob. Two shorter lines
// give each character roughly double the cell budget.
const EGG_LINES = ['ANDRE', 'POSMAN'];
const EGG_SUPERSAMPLE = 4; // supersample the mask so text stays legible on a coarse grid
const EGG_LINE_HEIGHT_FRACTION = 0.15; // each line's letter height as a fraction of grid rows
const EGG_LINE_GAP_FRACTION = 0.035; // gap between the two lines, as a fraction of grid rows
// Vertical position of the text block's center, as a fraction of grid rows.
// Dead center (0.5): Hero.astro fades the real hero text + scrim out for the
// duration of a reveal (see the 'asciiegg' event dispatched below), so there's
// no collision to dodge anymore — an earlier version parked this near the top
// edge to avoid the scrim, which clipped the letters against the viewport top.
const EGG_ROW_FRACTION = 0.5;
const EGG_ALPHA_THRESHOLD = 0.35; // averaged supersampled alpha needed to count a cell as "covered"
const EGG_FADE_IN = 0.4; // seconds
const EGG_HOLD = 1.6; // seconds
const EGG_FADE_OUT = 0.6; // seconds
const EGG_TOTAL = EGG_FADE_IN + EGG_HOLD + EGG_FADE_OUT;

// This banner reveal is click-triggered — a discoverable easter egg, not
// something that fires on its own.

// Separately: the full "andre posman" string appears, legible, laid out
// along one random row of the grid at normal glyph size — reads as part of
// the ambient field, not an overlay. Unlike the click banner above, this
// does NOT force cells to solid max density or quiet a backdrop band around
// them (that read as a stamped-on popup, not something living inside the
// field) — each name cell's density/color still comes from the same
// noise-driven target as every other cell, just floored so the letter never
// drops to fully blank, so it shimmers in weight over time exactly like its
// neighbors. Its letters are the only alphanumeric content in the field
// (everything else renders from the symbol-only RAMP above), so it already
// reads as distinct without needing special styling. Skipped fully under
// prefers-reduced-motion, same as the click banner.
const NAME_STRING = 'andre posman';
const NAME_REVEAL_MIN_LEVEL = 3; // floor so a letter is always at least faintly visible
const NAME_REVEAL_FIRST_DELAY_MIN = 3; // seconds
const NAME_REVEAL_FIRST_DELAY_MAX = 6;
const NAME_REVEAL_REPEAT_DELAY_MIN = 8;
const NAME_REVEAL_REPEAT_DELAY_MAX = 16;
const NAME_REVEAL_HOLD = 4; // seconds the string stays placed before moving elsewhere

interface Tier {
	min: number; // inclusive rounded density level this tier covers
	color: string;
}

function hash3(x: number, y: number, z: number): number {
	const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123;
	return s - Math.floor(s);
}

function smoothstep(t: number): number {
	return t * t * t * (t * (t * 6 - 15) + 10);
}

// Self-contained 3D value noise (x, y, time). No external noise dependency.
function valueNoise3D(x: number, y: number, z: number): number {
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const z0 = Math.floor(z);
	const u = smoothstep(x - x0);
	const v = smoothstep(y - y0);
	const w = smoothstep(z - z0);

	const c000 = hash3(x0, y0, z0);
	const c100 = hash3(x0 + 1, y0, z0);
	const c010 = hash3(x0, y0 + 1, z0);
	const c110 = hash3(x0 + 1, y0 + 1, z0);
	const c001 = hash3(x0, y0, z0 + 1);
	const c101 = hash3(x0 + 1, y0, z0 + 1);
	const c011 = hash3(x0, y0 + 1, z0 + 1);
	const c111 = hash3(x0 + 1, y0 + 1, z0 + 1);

	const x00 = c000 + (c100 - c000) * u;
	const x10 = c010 + (c110 - c010) * u;
	const x01 = c001 + (c101 - c001) * u;
	const x11 = c011 + (c111 - c011) * u;

	const y0i = x00 + (x10 - x00) * v;
	const y1i = x01 + (x11 - x01) * v;

	return y0i + (y1i - y0i) * w;
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

// Resolves any CSS color string (hex, named, etc.) to [r, g, b] by letting
// the browser parse it via a throwaway element, rather than hand-rolling a
// hex/rgb parser for the couple of theme custom properties we read.
function parseRgb(color: string): [number, number, number] {
	const probe = document.createElement('div');
	probe.style.color = color;
	document.body.appendChild(probe);
	const computed = getComputedStyle(probe).color;
	document.body.removeChild(probe);
	const match = computed.match(/[\d.]+/g);
	if (!match) return [255, 255, 255];
	return [Number(match[0]), Number(match[1]), Number(match[2])];
}

// Builds 5 color tiers spanning --fg-dim (dim gray, low density) to --fg
// (near-white/near-black depending on theme, high density), so the effect
// stays correct across the existing light/dark toggle without hardcoded colors.
function buildTiers(): Tier[] {
	const styles = getComputedStyle(document.documentElement);
	const fg = parseRgb(styles.getPropertyValue('--fg').trim() || '#f3f2ef');
	const fgDim = parseRgb(styles.getPropertyValue('--fg-dim').trim() || '#a3a1ab');

	const stops = [
		{ min: 1, mix: 0, alpha: 0.4 },
		{ min: 3, mix: 0.35, alpha: 0.58 },
		{ min: 5, mix: 0.6, alpha: 0.76 },
		{ min: 7, mix: 0.85, alpha: 0.9 },
		{ min: 9, mix: 1, alpha: 1 },
	];

	return stops.map(({ min, mix, alpha }) => {
		const r = Math.round(lerp(fgDim[0], fg[0], mix));
		const g = Math.round(lerp(fgDim[1], fg[1], mix));
		const b = Math.round(lerp(fgDim[2], fg[2], mix));
		return { min, color: `rgba(${r}, ${g}, ${b}, ${alpha})` };
	});
}

export function initAsciiField(canvas: HTMLCanvasElement): () => void {
	const ctx = canvas.getContext('2d');
	if (!ctx) return () => {};

	const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	let width = 0;
	let height = 0;
	let dpr = Math.min(window.devicePixelRatio || 1, 2);
	let cell = BASE_CELL;
	let cols = 0;
	let rows = 0;
	let current = new Float32Array(0);
	let noiseTime = 0;
	let rafId = 0;
	let lastTs = 0;
	let tiers = buildTiers();

	// Easter egg state
	let eggMask = new Uint8Array(0); // 1 = cell covered by a letter stroke
	let eggActive = false;
	let eggElapsed = 0;
	let currentEggEnvelope = 0; // set once per stepValues() call, read by targetLevel()

	// Ambient full-name reveal state. nameRevealMask: -1 = untouched, >=0 =
	// index into NAME_STRING for that cell.
	let nameRevealMask = new Int16Array(0);
	let nameRevealActive = false;
	let nameRevealElapsed = 0;
	let nameRevealTimeoutId = 0;

	const mouse = { x: -9999, y: -9999 };

	function computeCellSize(w: number, h: number): number {
		// Narrow screens get a finer grid (more cells across) so the
		// click-reveal letters keep enough cells per character to stay
		// legible. The default 16px grid only leaves ~4 cells per character
		// on a phone, which reads as a smudge rather than "ANDRE POSMAN".
		let size = w < 600 ? 12 : BASE_CELL;
		while (Math.ceil(w / size) * Math.ceil(h / size) > MAX_CELLS) {
			size += 2;
		}
		return size;
	}

	function targetLevel(gx: number, gy: number, idx: number): number {
		const n = valueNoise3D(gx * NOISE_FREQ, gy * NOISE_FREQ, noiseTime);
		let level = n * RAMP_MAX;

		if (!reduceMotion) {
			const dx = gx * cell - mouse.x;
			const dy = gy * cell - mouse.y;
			const dist = Math.hypot(dx, dy);
			if (dist < MOUSE_RADIUS) {
				// Blend toward max density near the pointer (not an additive nudge)
				// so the pointer reads as a clear "spotlight" regardless of what the
				// base noise happened to be doing at that spot.
				const t = smoothstep(1 - dist / MOUSE_RADIUS) * MOUSE_BOOST_STRENGTH;
				level = lerp(level, RAMP_MAX, t);
			}
		}

		if (currentEggEnvelope > 0) {
			// Easter egg reveal, layered on top of the noise/mouse target — the
			// existing current[idx] -> target lerp below smooths this in just
			// like everything else, no separate animation system needed.
			const m = eggMask[idx];
			if (m === 1) level = lerp(level, RAMP_MAX, currentEggEnvelope);
			else if (m === 2) level = lerp(level, 0, currentEggEnvelope);
		}

		if (nameRevealActive && nameRevealMask[idx] >= 0) {
			// Floor only — never force to max, so the letter still shimmers with
			// whatever the ambient noise is doing at that cell instead of sitting
			// as a flat, stamped-on block.
			level = Math.max(level, NAME_REVEAL_MIN_LEVEL);
		}

		return Math.min(RAMP_MAX, level);
	}

	// Tri-state coverage mask: 0 = untouched (normal ambient behavior), 1 =
	// letter ink (blended toward RAMP_MAX), 2 = backdrop within the text's
	// padded bounding box but not ink (blended toward 0). The backdrop state
	// exists because the ambient noise field already reaches near-max density
	// in places on its own (soft drifting blobs) — blending only the ink
	// cells upward isn't reliably legible against a background that might
	// already be just as dense right next to it. Quieting a small local
	// patch around the letters guarantees contrast regardless of what the
	// noise happens to be doing there; everywhere outside that patch keeps
	// its normal ambient behavior untouched.
	//
	// Built by rendering EGG_LINES to a supersampled offscreen canvas and
	// averaging alpha per grid cell — supersampled so the letterforms stay
	// legible even though the grid itself is coarse (tens of cells across,
	// not hundreds).
	function buildEggMask(): Uint8Array {
		const mask = new Uint8Array(cols * rows);
		if (cols === 0 || rows === 0) return mask;

		const ss = EGG_SUPERSAMPLE;
		const mw = cols * ss;
		const mh = rows * ss;
		const maskCanvas = document.createElement('canvas');
		maskCanvas.width = mw;
		maskCanvas.height = mh;
		const mctx = maskCanvas.getContext('2d');
		if (!mctx) return mask;

		mctx.clearRect(0, 0, mw, mh);
		mctx.fillStyle = '#fff';
		mctx.textAlign = 'center';
		mctx.textBaseline = 'middle';

		let fontSize = Math.round(rows * ss * EGG_LINE_HEIGHT_FRACTION);
		const maxWidth = mw * 0.92;
		mctx.font = `bold ${fontSize}px Arial, sans-serif`;
		while (
			(mctx.measureText(EGG_LINES[0]).width > maxWidth || mctx.measureText(EGG_LINES[1]).width > maxWidth) &&
			fontSize > 4
		) {
			fontSize -= 2;
			mctx.font = `bold ${fontSize}px Arial, sans-serif`;
		}

		const gapPx = rows * ss * EGG_LINE_GAP_FRACTION;
		const centerY = mh * EGG_ROW_FRACTION;
		const line1Y = centerY - (fontSize + gapPx) / 2;
		const line2Y = centerY + (fontSize + gapPx) / 2;
		mctx.fillText(EGG_LINES[0], mw / 2, line1Y);
		mctx.fillText(EGG_LINES[1], mw / 2, line2Y);

		const img = mctx.getImageData(0, 0, mw, mh).data;
		let minGx = cols;
		let maxGx = -1;
		let minGy = rows;
		let maxGy = -1;
		for (let gy = 0; gy < rows; gy++) {
			for (let gx = 0; gx < cols; gx++) {
				let sum = 0;
				for (let sy = 0; sy < ss; sy++) {
					for (let sx = 0; sx < ss; sx++) {
						const px = gx * ss + sx;
						const py = gy * ss + sy;
						sum += img[(py * mw + px) * 4 + 3];
					}
				}
				const avgAlpha = sum / (ss * ss * 255);
				if (avgAlpha > EGG_ALPHA_THRESHOLD) {
					mask[gy * cols + gx] = 1;
					if (gx < minGx) minGx = gx;
					if (gx > maxGx) maxGx = gx;
					if (gy < minGy) minGy = gy;
					if (gy > maxGy) maxGy = gy;
				}
			}
		}

		if (maxGx >= minGx) {
			const pad = 2;
			minGx = Math.max(0, minGx - pad);
			maxGx = Math.min(cols - 1, maxGx + pad);
			minGy = Math.max(0, minGy - pad);
			maxGy = Math.min(rows - 1, maxGy + pad);
			for (let gy = minGy; gy <= maxGy; gy++) {
				for (let gx = minGx; gx <= maxGx; gx++) {
					const idx = gy * cols + gx;
					if (mask[idx] !== 1) mask[idx] = 2;
				}
			}
		}

		return mask;
	}

	function eggEnvelopeValue(): number {
		if (!eggActive) return 0;
		const t = eggElapsed;
		if (t < EGG_FADE_IN) return t / EGG_FADE_IN;
		if (t < EGG_FADE_IN + EGG_HOLD) return 1;
		if (t < EGG_TOTAL) return 1 - (t - EGG_FADE_IN - EGG_HOLD) / EGG_FADE_OUT;
		return 0;
	}

	function stepValues(dt: number, snap: boolean) {
		if (!reduceMotion) {
			noiseTime += dt * NOISE_TIME_SPEED;
		}

		if (eggActive) {
			eggElapsed += dt;
			if (eggElapsed >= EGG_TOTAL) {
				eggActive = false;
				eggElapsed = 0;
				canvas.dispatchEvent(new CustomEvent('asciiegg', { detail: { active: false } }));
			}
		}
		currentEggEnvelope = eggEnvelopeValue();

		if (nameRevealActive) {
			nameRevealElapsed += dt;
			if (nameRevealElapsed >= NAME_REVEAL_HOLD) {
				nameRevealActive = false;
				nameRevealElapsed = 0;
				nameRevealMask.fill(-1);
				scheduleNextNameReveal(false);
			}
		}

		const lerpT = snap ? 1 : Math.min(1, dt * LERP_RATE);

		for (let gy = 0; gy < rows; gy++) {
			for (let gx = 0; gx < cols; gx++) {
				const idx = gy * cols + gx;
				const target = targetLevel(gx, gy, idx);
				current[idx] = lerp(current[idx], target, lerpT);
			}
		}
	}

	function paint() {
		// Bucket cells by color tier so fillStyle is only set once per tier
		// (4-5 times total) instead of once per character.
		const buckets: number[][] = tiers.map(() => []);

		for (let idx = 0; idx < current.length; idx++) {
			const level = Math.round(current[idx]);
			if (level <= 0) continue; // space glyph, nothing to draw

			let tierIndex = 0;
			for (let i = tiers.length - 1; i >= 0; i--) {
				if (level >= tiers[i].min) {
					tierIndex = i;
					break;
				}
			}
			buckets[tierIndex].push(idx, level);
		}

		ctx.clearRect(0, 0, width, height);
		for (let t = 0; t < tiers.length; t++) {
			const bucket = buckets[t];
			if (bucket.length === 0) continue;
			ctx.fillStyle = tiers[t].color;
			for (let i = 0; i < bucket.length; i += 2) {
				const idx = bucket[i];
				const level = bucket[i + 1];
				const gx = idx % cols;
				const gy = (idx / cols) | 0;
				// Ink cells keep the clean ramp glyph during a click-banner reveal
				// rather than the name string poking through, so letterform edges
				// stay crisp.
				const bannerInkActive = currentEggEnvelope > 0 && eggMask[idx] === 1;
				const nameCharIdx = bannerInkActive ? -1 : nameRevealMask[idx];
				const nameChar = nameCharIdx >= 0 ? NAME_STRING[nameCharIdx] : null;
				const glyph = nameChar ?? RAMP[level];
				ctx.fillText(glyph, gx * cell + cell / 2, gy * cell + cell / 2);
			}
		}
	}

	function resize() {
		width = canvas.clientWidth;
		height = canvas.clientHeight;
		dpr = Math.min(window.devicePixelRatio || 1, 2);
		canvas.width = width * dpr;
		canvas.height = height * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		cell = computeCellSize(width, height);
		cols = Math.ceil(width / cell) + 1;
		rows = Math.ceil(height / cell) + 1;
		current = new Float32Array(cols * rows);
		nameRevealMask = new Int16Array(cols * rows).fill(-1);
		eggMask = buildEggMask();

		ctx.font = `${Math.round(cell * 0.85)}px 'JetBrains Mono', ui-monospace, monospace`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';

		stepValues(0, true);
		paint();
	}

	function tick(ts: number) {
		if (!lastTs) lastTs = ts;
		const elapsed = ts - lastTs;
		if (elapsed >= REDRAW_INTERVAL) {
			stepValues(elapsed / 1000, false);
			paint();
			lastTs = ts;
		}
		rafId = requestAnimationFrame(tick);
	}

	function onPointerMove(e: PointerEvent) {
		const rect = canvas.getBoundingClientRect();
		mouse.x = e.clientX - rect.left;
		mouse.y = e.clientY - rect.top;
	}

	function onPointerLeave() {
		mouse.x = -9999;
		mouse.y = -9999;
	}

	function randomBetween(min: number, max: number): number {
		return min + Math.random() * (max - min);
	}

	function fireEgg() {
		if (eggActive) return; // don't stack a second reveal on top of one already running
		eggActive = true;
		eggElapsed = 0;
		canvas.dispatchEvent(new CustomEvent('asciiegg', { detail: { active: true } }));
	}

	// Mobile tap detection: iOS/Android can be unreliable about synthesizing
	// a `click` on a non-interactive <canvas>, so we listen for touchend
	// directly and treat a short, low-movement touch as the same tap. A
	// scroll/swipe (larger movement) is ignored so the easter egg doesn't
	// fire mid-scroll. fireEgg()'s eggActive guard makes the extra path safe
	// to overlap with a real click on devices that fire both.
	let touchStartX = 0;
	let touchStartY = 0;
	let touchStartTime = 0;

	function onTouchStart(e: TouchEvent) {
		const t = e.touches[0];
		if (!t) return;
		touchStartX = t.clientX;
		touchStartY = t.clientY;
		touchStartTime = Date.now();
	}

	function onTouchEnd(e: TouchEvent) {
		const t = e.changedTouches[0];
		if (!t) return;
		const dx = t.clientX - touchStartX;
		const dy = t.clientY - touchStartY;
		const dt = Date.now() - touchStartTime;
		if (Math.hypot(dx, dy) < 10 && dt < 500) fireEgg();
	}

	// Lines up the next unprompted appearance of the full name string. Never
	// called at all under prefers-reduced-motion (see the !reduceMotion guard
	// at the bottom of this function's call sites) — a fully static field
	// must stay static.
	function scheduleNextNameReveal(first: boolean) {
		clearTimeout(nameRevealTimeoutId);
		const delay = first
			? randomBetween(NAME_REVEAL_FIRST_DELAY_MIN, NAME_REVEAL_FIRST_DELAY_MAX)
			: randomBetween(NAME_REVEAL_REPEAT_DELAY_MIN, NAME_REVEAL_REPEAT_DELAY_MAX);
		nameRevealTimeoutId = window.setTimeout(fireNameReveal, delay * 1000);
	}

	// Lays "andre posman" out along one random row, at a random horizontal
	// position, one character per cell — legible as a straight run of text
	// rather than a centered banner. Requires the grid to be at least as wide
	// as the string; skips this cycle on a pathologically narrow viewport.
	function fireNameReveal() {
		if (nameRevealActive || cols < NAME_STRING.length || rows === 0) return;

		const startCol = Math.floor(Math.random() * (cols - NAME_STRING.length + 1));
		const row = Math.floor(Math.random() * rows);

		nameRevealMask.fill(-1);
		for (let i = 0; i < NAME_STRING.length; i++) {
			if (NAME_STRING[i] !== ' ') nameRevealMask[row * cols + startCol + i] = i;
		}

		nameRevealActive = true;
		nameRevealElapsed = 0;
	}

	function onThemeChange() {
		tiers = buildTiers();
		paint();
	}

	function onVisibilityChange() {
		if (document.hidden) {
			cancelAnimationFrame(rafId);
			clearTimeout(nameRevealTimeoutId); // don't fire/queue an appearance nobody's there to see
		} else {
			lastTs = 0;
			rafId = requestAnimationFrame(tick);
			if (!nameRevealActive) scheduleNextNameReveal(false); // fresh random wait once they're back
		}
	}

	resize();
	window.addEventListener('resize', resize);
	window.addEventListener('themechange', onThemeChange);

	if (!reduceMotion) {
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerleave', onPointerLeave);
		canvas.addEventListener('click', fireEgg);
		canvas.addEventListener('touchstart', onTouchStart, { passive: true });
		canvas.addEventListener('touchend', onTouchEnd);
		document.addEventListener('visibilitychange', onVisibilityChange);
		rafId = requestAnimationFrame(tick);
		scheduleNextNameReveal(true);
	}
	// reduced motion: resize() already painted one static frame above and no
	// loop is started — no noise animation, no pointer-reactive boost, no
	// click listener, and the scattered name letters never auto-fire (see
	// scheduleNextNameReveal's doc comment).

	return function dispose() {
		cancelAnimationFrame(rafId);
		clearTimeout(nameRevealTimeoutId);
		window.removeEventListener('resize', resize);
		window.removeEventListener('themechange', onThemeChange);
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerleave', onPointerLeave);
		canvas.removeEventListener('click', fireEgg);
		canvas.removeEventListener('touchstart', onTouchStart);
		canvas.removeEventListener('touchend', onTouchEnd);
		document.removeEventListener('visibilitychange', onVisibilityChange);
	};
}
