import * as assert from 'assert';
import { test } from 'node:test';
import { diffLines, takeSelection } from '../../src/lineDiff';

const cursor = (line: number) => ({ start: line, end: line, cursor: true });
const lines = (start: number, end: number) => ({ start, end, cursor: false });

/** Applying every hunk must turn the target into the source. */
function assertHunksAreComplete(source: string[], target: string[]): void {
	const result = [...target];
	for (const hunk of [...diffLines(source, target)].reverse()) {
		result.splice(hunk.targetStart, hunk.targetEnd - hunk.targetStart, ...source.slice(hunk.sourceStart, hunk.sourceEnd));
	}
	assert.deepStrictEqual(result, source);
}

test('diffLines finds insertions, removals and replacements', () => {
	assert.deepStrictEqual(diffLines(['a', 'b'], ['a', 'b']), []);
	assert.deepStrictEqual(diffLines(['a', 'x', 'b'], ['a', 'b']), [{ sourceStart: 1, sourceEnd: 2, targetStart: 1, targetEnd: 1 }]);
	assert.deepStrictEqual(diffLines(['a', 'b'], ['a', 'x', 'b']), [{ sourceStart: 1, sourceEnd: 1, targetStart: 1, targetEnd: 2 }]);
	assert.deepStrictEqual(diffLines(['a', 'x', 'b'], ['a', 'y', 'b']), [{ sourceStart: 1, sourceEnd: 2, targetStart: 1, targetEnd: 2 }]);
});

test('diffLines keeps hunks apart when lines between them match', () => {
	assert.deepStrictEqual(diffLines(['1', 'a', '3', '4', 'b', '6'], ['1', '2', '3', '4', '5', '6']), [
		{ sourceStart: 1, sourceEnd: 2, targetStart: 1, targetEnd: 2 },
		{ sourceStart: 4, sourceEnd: 5, targetStart: 4, targetEnd: 5 }
	]);
});

test('diffLines hunks reproduce random edits', () => {
	let seed = 12345;
	const random = (limit: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % limit;
	for (let round = 0; round < 500; round++) {
		const source = Array.from({ length: random(40) }, () => String(random(6)));
		const target = Array.from({ length: random(40) }, () => String(random(6)));
		assertHunksAreComplete(source, target);
	}
});

test('takeSelection takes only the hunk under the cursor', () => {
	const source = ['1', 'a', '3', '4', 'b', '6'];
	const target = ['1', '2', '3', '4', '5', '6'];
	assert.deepStrictEqual(takeSelection(source, target, 'source', [cursor(1)]), ['1', 'a', '3', '4', '5', '6']);
	assert.deepStrictEqual(takeSelection(source, target, 'target', [cursor(4)]), ['1', '2', '3', '4', 'b', '6']);
	assert.strictEqual(takeSelection(source, target, 'source', [cursor(2)]), undefined);
});

test('takeSelection replaces selected lines of a partly selected hunk', () => {
	const source = ['x', 'A', 'B', 'C', 'y'];
	const target = ['x', 'a', 'b', 'c', 'y'];
	assert.deepStrictEqual(takeSelection(source, target, 'source', [lines(2, 2)]), ['x', 'a', 'B', 'c', 'y']);
	assert.deepStrictEqual(takeSelection(source, target, 'target', [lines(1, 2)]), ['x', 'A', 'B', 'c', 'y']);
});

test('takeSelection inserts part of an added block', () => {
	const source = ['x', 'n1', 'n2', 'n3', 'y'];
	const target = ['x', 'y'];
	assert.deepStrictEqual(takeSelection(source, target, 'source', [lines(1, 1), lines(3, 3)]), ['x', 'n1', 'n3', 'y']);
});

test('takeSelection removes part of a removed block', () => {
	const source = ['x', 'y'];
	const target = ['x', 'o1', 'o2', 'y'];
	assert.deepStrictEqual(takeSelection(source, target, 'target', [lines(2, 2)]), ['x', 'o1', 'y']);
	assert.deepStrictEqual(takeSelection(source, target, 'source', [cursor(0)]), ['x', 'y']);
});

test('takeSelection handles a new file and a missing final newline', () => {
	assert.deepStrictEqual(takeSelection(['a', 'b', ''], [''], 'source', [cursor(0)]), ['a', 'b', '']);
	assert.deepStrictEqual(takeSelection(['a', 'b', ''], ['a', 'b'], 'source', [cursor(2)]), ['a', 'b', '']);
});

test('diffLines survives a file that changed completely', () => {
	const source = Array.from({ length: 30000 }, (_, i) => `s${i}`);
	const target = Array.from({ length: 30000 }, (_, i) => `t${i}`);
	assertHunksAreComplete(source, target);
});
