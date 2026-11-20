import { diffLines, Hunk } from './lineDiff';

const lines = (text: string) => text.replace(/\r\n/g, '\n').split('\n');

/**
 * Whether an edit of the Index document took whole blocks over from the other side of its diff, as the
 * diff editor's arrow does: some of the blocks that differed between the two sides are gone, and every
 * other block is as it was. The arrow edits the characters that differ, not whole lines, so the edit is
 * judged by what it did to the blocks rather than by its shape. An edit typed by hand that makes a whole
 * block equal to the other side is therefore recognized too.
 *
 * With a selection, the arrow takes only the selected part of a block. The block changes but stays, so
 * that edit is not recognized and waits for a save like any edit.
 */
export function isBlockMove(other: string, before: string, after: string): boolean {
	const source = lines(other);
	const was = lines(before);
	const now = lines(after);
	const block = (hunk: Hunk, target: readonly string[]) =>
		JSON.stringify([hunk.sourceStart, hunk.sourceEnd, target.slice(hunk.targetStart, hunk.targetEnd)]);
	const blocksBefore = diffLines(source, was);
	const blocksAfter = diffLines(source, now);
	const kept = new Set(blocksBefore.map(hunk => block(hunk, was)));
	return blocksAfter.length < blocksBefore.length && blocksAfter.every(hunk => kept.has(block(hunk, now)));
}
