import * as assert from 'assert';
import { test } from 'node:test';
import { isBlockMove } from '../../src/blockMove';

test('isBlockMove recognizes a block of new lines taken into the Index', () => {
	const workingTree = 'a\nnew 1\nnew 2\nb\nc\nchanged\n';
	assert.ok(isBlockMove(workingTree, 'a\nb\nc\nd\n', 'a\nnew 1\nnew 2\nb\nc\nd\n'));
});

test('isBlockMove recognizes a replaced line, a removed line and the last line of the file', () => {
	assert.ok(isBlockMove('a\nB\nc', 'a\nb\nc', 'a\nB\nc'), 'a replaced line');
	assert.ok(isBlockMove('a\nc\n', 'a\nb\nc\n', 'a\nc\n'), 'a removed line');
	assert.ok(isBlockMove('a\nb\nC', 'a\nb\nc', 'a\nb\nC'), 'the last line, without a line break');
});

test('isBlockMove recognizes several blocks taken at once, and the last block', () => {
	const other = 'a\nB\nc\nd\nE\n';
	assert.ok(isBlockMove(other, 'a\nb\nc\nd\ne\n', 'a\nB\nc\nd\nE\n'));
	assert.ok(isBlockMove(other, 'a\nb\nc\nd\ne\n', 'a\nB\nc\nd\ne\n'), 'the other block stays as it was');
});

test('isBlockMove ignores line endings', () => {
	assert.ok(isBlockMove('a\r\nB\r\nc\r\n', 'a\nb\nc\n', 'a\nB\nc\n'));
});

test('isBlockMove can ignore leading and trailing whitespace, as the diff editor does', () => {
	const other = 'a\nfour FIVE\nc\n';
	const before = 'a\n  four five\nc\n';
	const after = 'a\n  four FIVE\nc\n';
	assert.ok(!isBlockMove(other, before, after), 'the indentation still differs');
	assert.ok(isBlockMove(other, before, after, true));
	assert.ok(!isBlockMove(other, before, 'a\n    four five\nc\n', true), 'changing only the indentation takes no block');
});

test('isBlockMove leaves other edits alone', () => {
	const other = 'a\nb\nc\nd\n';
	const index = 'a\nx\nc\ny\n';
	assert.ok(!isBlockMove(other, index, index), 'nothing changed');
	assert.ok(!isBlockMove(other, index, 'a\nxz\nc\ny\n'), 'typing in a block');
	assert.ok(!isBlockMove(other, index, 'a\nx\nc\nd\ne\n'), 'a block taken, another line added');
	assert.ok(!isBlockMove(other, index, 'a\nb\nc\nz\n'), 'a block taken, another block changed');
	assert.ok(!isBlockMove(other, 'a\nb\nc\nd\n', 'a\nb\nb\nc\nd\n'), 'a line of the other side that adds a difference');
	assert.ok(!isBlockMove('a\nB\nC\nd\n', 'a\nb\nc\nd\n', 'a\nB\nc\nd\n'), 'part of a block, as the arrow takes a selection');
});
