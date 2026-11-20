import { diffLines, Hunk } from './lineDiff';

/**
 * Whether an edit of the Index document took whole blocks over from the other side of its diff, as the
 * diff editor's arrow does: some of the blocks that differed between the two sides are gone, and every
 * other block is as it was. The arrow edits the characters that differ, not whole lines, so the edit is
 * judged by what it did to the blocks rather than by its shape. An edit typed by hand that makes a whole
 * block equal to the other side is therefore recognized too.
 *
 * With a selection, the arrow takes only the selected part of a block. The block changes but stays, so
 * that edit is not recognized and waits for a save like any edit.
 *
 * @param ignoreTrimWhitespace Whether lines that differ only in leading and trailing whitespace count
 * as equal, as in the diff editor with `diffEditor.ignoreTrimWhitespace`. Its arrow then leaves that
 * whitespace as it is.
 */
export function isBlockMove(other: string, before: string, after: string, ignoreTrimWhitespace = false): boolean {
	const lines = (text: string) => {
		const split = text.replace(/\r\n/g, '\n').split('\n');
		return ignoreTrimWhitespace ? split.map(line => line.trim()) : split;
	};
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
