import * as assert from 'assert';
import { test } from 'node:test';
import { buildNodes, Entry, entriesOf, FolderNode, markPartial, matchesFilter, Node, pathsOf, sortEntries } from '../../src/staging/entries';
import { stripComments } from '../../src/staging/strip';

const entry = (path: string, kind: Entry['kind'] = 'modified', list: Entry['list'] = 'unstaged'): Entry =>
	({ list, path, kind, partial: false });

/** The tree as indented labels, to compare shapes. */
function shape(nodes: readonly Node[], depth = 0): string[] {
	return nodes.flatMap(node => node.type === 'file'
		? [`${'  '.repeat(depth)}${node.entry.path.split('/').pop()}`]
		: [`${'  '.repeat(depth)}${node.label}/`, ...shape(node.children, depth + 1)]);
}

test('matchesFilter: substring, wildcards, case', () => {
	assert.ok(matchesFilter('src/Parser.ts', 'parser'));
	assert.ok(matchesFilter('src/Parser.ts', ''));
	assert.ok(matchesFilter('src/Parser.ts', '*.ts'));
	assert.ok(matchesFilter('src/a/b/Parser.ts', 'src*parser'));
	assert.ok(matchesFilter('src/p1.ts', 'p?.ts'));
	assert.ok(!matchesFilter('src/p10.ts', 'p?.ts'));
	assert.ok(!matchesFilter('src/Parser.ts', '*.js'));
	assert.ok(matchesFilter('a(b)+c.txt', '(b)+'), 'regular expression characters are literal');
});

test('markPartial marks paths found in both lists, but not untracked ones', () => {
	const { unstaged, staged } = markPartial(
		[entry('a.txt'), entry('b.txt'), entry('c.txt', 'untracked')],
		[entry('a.txt', 'modified', 'staged'), entry('c.txt', 'added', 'staged')]
	);
	assert.deepStrictEqual(unstaged.map(e => e.partial), [true, false, true]);
	assert.deepStrictEqual(staged.map(e => e.partial), [true, false]);
});

test('sortEntries by name ignores case; by status groups kinds', () => {
	const entries = [entry('b.txt', 'untracked'), entry('A.txt', 'deleted'), entry('c.txt', 'conflict'), entry('a2.txt')];
	assert.deepStrictEqual(sortEntries(entries, 'name').map(e => e.path), ['A.txt', 'a2.txt', 'b.txt', 'c.txt']);
	assert.deepStrictEqual(sortEntries(entries, 'status').map(e => e.path), ['c.txt', 'a2.txt', 'A.txt', 'b.txt']);
});

test('buildNodes: list, tree and compact tree', () => {
	const entries = [entry('src/app/main.ts'), entry('src/app/util.ts'), entry('docs/guide/intro.md'), entry('README.md')];
	assert.deepStrictEqual(shape(buildNodes('unstaged', entries, 'list')), ['main.ts', 'util.ts', 'intro.md', 'README.md']);
	assert.deepStrictEqual(shape(buildNodes('unstaged', entries, 'tree')), [
		'docs/', '  guide/', '    intro.md',
		'src/', '  app/', '    main.ts', '    util.ts',
		'README.md'
	]);
	const compact = buildNodes('unstaged', entries, 'compactTree');
	assert.deepStrictEqual(shape(compact), ['docs/guide/', '  intro.md', 'src/app/', '  main.ts', '  util.ts', 'README.md']);
	assert.strictEqual((compact[1] as FolderNode).path, 'src/app');
	assert.deepStrictEqual(entriesOf(compact[1]).map(e => e.path), ['src/app/main.ts', 'src/app/util.ts']);
});

test('pathsOf includes both sides of a rename once', () => {
	const renamed: Entry = { list: 'staged', path: 'new.txt', originalPath: 'old.txt', kind: 'renamed', partial: false };
	assert.deepStrictEqual(pathsOf([renamed, entry('new.txt')]), ['new.txt', 'old.txt']);
});

test('stripComments drops comment lines and trailing blank lines', () => {
	assert.strictEqual(stripComments('Summary\n\n# hint\nbody\n# more\n\n'), 'Summary\n\nbody');
	assert.strictEqual(stripComments('Merge\r\n; note\r\n', ';'), 'Merge');
});
