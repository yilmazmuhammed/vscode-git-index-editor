import { diffLines } from './lineDiff';

/** One replacement in a document, as `TextDocumentContentChangeEvent` describes it. */
export interface TextChange {
	/** Offset of the replaced text in the document before the change. */
	readonly offset: number;
	/** Length of the replaced text. */
	readonly length: number;
	/** The text put in its place. */
	readonly text: string;
}

const normalize = (text: string) => text.replace(/\r\n/g, '\n');

/** How many lines differ between two texts: the lines of every hunk, on both sides. */
export function differingLines(a: string, b: string): number {
	return diffLines(normalize(a).split('\n'), normalize(b).split('\n'))
		.reduce((count, hunk) => count + hunk.sourceEnd - hunk.sourceStart + hunk.targetEnd - hunk.targetStart, 0);
}

/** Whether `block` is empty or a run of whole lines of `text`: ending with a line break, or at the end of `text`. */
export function isLineBlockOf(block: string, text: string): boolean {
	if (!block) {
		return true;
	}
	const lines = normalize(block);
	const whole = normalize(text);
	return lines.endsWith('\n')
		? `\n${whole}`.includes(`\n${lines}`)
		: whole === lines || whole.endsWith(`\n${lines}`);
}

/** Whether `change` replaces whole lines of `before` with whole lines of `other`, or with nothing. */
function movesLines(change: TextChange, other: string, before: string): boolean {
	const end = change.offset + change.length;
	const replaced = before.slice(change.offset, end);
	const startsAtLine = change.offset === 0 || before[change.offset - 1] === '\n';
	const replacesWholeLines = replaced === '' || replaced.endsWith('\n') || end === before.length;
	return startsAtLine && replacesWholeLines && replaced !== change.text && isLineBlockOf(change.text, other);
}

/**
 * Whether the changes of the Index document in one edit are what the diff editor does to blocks when
 * its arrow is clicked, or when Revert runs from the Command Palette: each change replaces whole lines
 * of the Index with whole lines of the other side, or with nothing, and fewer lines differ between the
 * two sides afterwards. The offsets of all changes refer to `before`, as VS Code reports them.
 *
 * With a selection, the arrow reverts only the selected characters; those changes are not recognized
 * and wait for a save like any edit.
 */
export function isBlockMove(changes: readonly TextChange[], other: string, before: string, after: string): boolean {
	return changes.length > 0
		&& changes.every(change => movesLines(change, other, before))
		&& differingLines(other, after) < differingLines(other, before);
}
