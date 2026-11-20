import * as assert from 'assert';
import { test } from 'node:test';
import { differingLines, isBlockMove, isLineBlockOf, TextChange } from '../../src/blockMove';

/** Applies `changes`, last first, to `before` and asks whether they are a block move from `other`. */
function moved(other: string, before: string, ...changes: TextChange[]): boolean {
	const after = [...changes].sort((a, b) => b.offset - a.offset)
		.reduce((text, change) => text.slice(0, change.offset) + change.text + text.slice(change.offset + change.length), before);
	return isBlockMove(changes, other, before, after);
}

/** The change that replaces `[from, to)` of `before` with `text`. */
function replace(before: string, from: string, to: string | undefined, text: string): TextChange {
	const offset = before.indexOf(from);
	const end = to === undefined ? before.length : before.indexOf(to, offset);
	return { offset, length: end - offset, text };
}

test('differingLines counts the lines of every hunk on both sides', () => {
	assert.strictEqual(differingLines('a\nb\n', 'a\nb\n'), 0);
	assert.strictEqual(differingLines('a\nx\nb\n', 'a\nb\n'), 1);
	assert.strictEqual(differingLines('a\nx\nb\n', 'a\ny\nb\n'), 2);
	assert.strictEqual(differingLines('a\r\nb\r\n', 'a\nb\n'), 0, 'line endings do not count');
});

test('isLineBlockOf accepts whole lines only', () => {
	assert.ok(isLineBlockOf('', 'a\n'));
	assert.ok(isLineBlockOf('b\nc\n', 'a\nb\nc\nd\n'));
	assert.ok(isLineBlockOf('c', 'a\nb\nc'), 'the last line without a line break');
	assert.ok(isLineBlockOf('b\r\n', 'a\nb\n'), 'line endings do not count');
	assert.ok(!isLineBlockOf('b', 'a\nb\nc\n'), 'a line in the middle needs its line break');
	assert.ok(!isLineBlockOf('b\n', 'ab\n'), 'part of a line is not a line');
});

test('isBlockMove recognizes the arrow taking a block of new lines into the Index', () => {
	const workingTree = 'a\nnew 1\nnew 2\nb\nc\nchanged\n';
	const index = 'a\nb\nc\nd\n';
	assert.ok(moved(workingTree, index, { offset: 2, length: 0, text: 'new 1\nnew 2\n' }));
});

test('isBlockMove recognizes a replaced line, a removed line and the last line of the file', () => {
	const other = 'a\nB\nc';
	assert.ok(moved(other, 'a\nb\nc', replace('a\nb\nc', 'b', 'c', 'B\n')), 'a replaced line');
	assert.ok(moved('a\nc\n', 'a\nb\nc\n', replace('a\nb\nc\n', 'b', 'c', '')), 'a removed line');
	assert.ok(moved('a\nb\nC', 'a\nb\nc', replace('a\nb\nc', 'c', undefined, 'C')), 'the last line, without a line break');
});

test('isBlockMove recognizes several blocks moved in one edit', () => {
	const other = 'a\nB\nc\nd\nE\n';
	const index = 'a\nb\nc\nd\ne\n';
	assert.ok(moved(other, index, replace(index, 'b', 'c', 'B\n'), replace(index, 'e', undefined, 'E\n')));
	assert.ok(!moved(other, index, replace(index, 'b', 'c', 'B\n'), { offset: 7, length: 0, text: 'x' }),
		'one change that is not a block spoils the edit');
});

test('isBlockMove leaves typing and other edits alone', () => {
	const other = 'a\nb\nc\n';
	const index = 'a\nx\nc\n';
	assert.ok(!moved(other, index, { offset: 2, length: 1, text: 'b' }), 'typing over part of a line');
	assert.ok(!moved(other, index, replace(index, 'x', 'c', 'y\n')), 'lines the other side does not have');
	assert.ok(!moved(other, index, { offset: 3, length: 0, text: '\nb' }), 'text that does not start at a line');
	assert.ok(!moved(other, 'a\nc\n', { offset: 2, length: 0, text: 'a\n' }), 'a line of the other side that adds a difference');
	assert.ok(!moved(other, index, { offset: 2, length: 0, text: '' }), 'nothing changed');
});
