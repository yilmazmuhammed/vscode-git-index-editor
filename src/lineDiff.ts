/** A block of lines that differs: `source[sourceStart, sourceEnd)` against `target[targetStart, targetEnd)`. */
export interface Hunk {
	readonly sourceStart: number;
	readonly sourceEnd: number;
	readonly targetStart: number;
	readonly targetEnd: number;
}

/** Beyond this many edits the remaining middle of the file is treated as one hunk. */
const MAX_EDIT_DISTANCE = 4000;

/** Myers' greedy diff. Marks in `matches` the target line paired with each source line. */
function myers(source: readonly string[], target: readonly string[], offset: number, sourceEnd: number, targetEnd: number, matches: Int32Array): void {
	const n = sourceEnd - offset;
	const m = targetEnd - offset;
	const limit = Math.min(n + m, MAX_EDIT_DISTANCE);
	const center = limit + 1;
	const frontier = new Int32Array(2 * limit + 3);
	const trace: Int32Array[] = [];

	const chooseDown = (values: (k: number) => number, k: number, d: number) =>
		k === -d || (k !== d && values(k - 1) < values(k + 1));

	for (let d = 0; d <= limit; d++) {
		trace.push(frontier.slice(center - d - 1, center + d + 2));
		for (let k = -d; k <= d; k += 2) {
			const down = chooseDown(i => frontier[center + i], k, d);
			let x = down ? frontier[center + k + 1] : frontier[center + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && source[offset + x] === target[offset + y]) {
				x++;
				y++;
			}
			frontier[center + k] = x;
			if (x >= n && y >= m) {
				backtrack(n, m);
				return;
			}
		}
	}

	function backtrack(endX: number, endY: number): void {
		let x = endX;
		let y = endY;
		for (let d = trace.length - 1; d >= 0; d--) {
			const saved = trace[d];
			const value = (i: number) => saved[i + d + 1];
			const k = x - y;
			const previousK = chooseDown(value, k, d) ? k + 1 : k - 1;
			const previousX = value(previousK);
			const previousY = previousX - previousK;
			while (x > previousX && y > previousY && x > 0 && y > 0) {
				x--;
				y--;
				matches[offset + x] = offset + y;
			}
			x = previousX;
			y = previousY;
		}
	}
}

export function diffLines(source: readonly string[], target: readonly string[]): Hunk[] {
	let prefix = 0;
	const shortest = Math.min(source.length, target.length);
	while (prefix < shortest && source[prefix] === target[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (suffix < shortest - prefix && source[source.length - 1 - suffix] === target[target.length - 1 - suffix]) {
		suffix++;
	}

	const sourceEnd = source.length - suffix;
	const targetEnd = target.length - suffix;
	const matches = new Int32Array(source.length).fill(-1);
	if (prefix < sourceEnd && prefix < targetEnd) {
		myers(source, target, prefix, sourceEnd, targetEnd, matches);
	}

	const hunks: Hunk[] = [];
	let s = prefix;
	let t = prefix;
	while (s < sourceEnd || t < targetEnd) {
		const sourceStart = s;
		const targetStart = t;
		while (s < sourceEnd && matches[s] < 0) {
			s++;
		}
		const nextTarget = s < sourceEnd ? matches[s] : targetEnd;
		t = nextTarget;
		if (s > sourceStart || t > targetStart) {
			hunks.push({ sourceStart, sourceEnd: s, targetStart, targetEnd: t });
		}
		if (s < sourceEnd) {
			s++;
			t++;
		}
	}
	return hunks;
}

/** Inclusive line range in one of the two sides. A `cursor` range stands for the whole hunk it touches. */
export interface LineSelection {
	readonly start: number;
	readonly end: number;
	readonly cursor: boolean;
}

function range(hunk: Hunk, side: 'source' | 'target'): [number, number] {
	return side === 'source' ? [hunk.sourceStart, hunk.sourceEnd] : [hunk.targetStart, hunk.targetEnd];
}

function hunkAtCursor(hunks: readonly Hunk[], side: 'source' | 'target', line: number): Hunk | undefined {
	const inside = hunks.find(hunk => {
		const [start, end] = range(hunk, side);
		return line >= start && line < end;
	});
	if (inside) {
		return inside;
	}
	// A hunk with no lines on this side is shown as a gap between two lines.
	return hunks.find(hunk => {
		const [start, end] = range(hunk, side);
		return start === end && (line === start || line === start - 1);
	});
}

/**
 * Returns `target` with the selected changes taken from `source`, or undefined if the selection
 * touches no change. The lines of a hunk are paired from the top, so a partial selection replaces
 * each selected line with its counterpart; a line without a counterpart is inserted or removed.
 */
export function takeSelection(
	source: readonly string[],
	target: readonly string[],
	side: 'source' | 'target',
	selections: readonly LineSelection[]
): string[] | undefined {
	const hunks = diffLines(source, target);
	const wholeHunks = new Set<Hunk>();
	for (const selection of selections) {
		const hunk = selection.cursor ? hunkAtCursor(hunks, side, selection.start) : undefined;
		if (hunk) {
			wholeHunks.add(hunk);
		}
	}
	const isSelected = (line: number) => selections.some(s => !s.cursor && line >= s.start && line <= s.end);

	const result: string[] = [];
	let changed = false;
	let position = 0;
	for (const hunk of hunks) {
		result.push(...target.slice(position, hunk.targetStart));
		position = hunk.targetEnd;
		const sourceCount = hunk.sourceEnd - hunk.sourceStart;
		const targetCount = hunk.targetEnd - hunk.targetStart;
		for (let i = 0; i < Math.max(sourceCount, targetCount); i++) {
			const sideLine = (side === 'source' ? hunk.sourceStart : hunk.targetStart) + i;
			const sideCount = side === 'source' ? sourceCount : targetCount;
			const take = wholeHunks.has(hunk) || (i < sideCount && isSelected(sideLine));
			changed ||= take;
			if (take && i < sourceCount) {
				result.push(source[hunk.sourceStart + i]);
			} else if (!take && i < targetCount) {
				result.push(target[hunk.targetStart + i]);
			}
		}
	}
	result.push(...target.slice(position));
	return changed ? result : undefined;
}
