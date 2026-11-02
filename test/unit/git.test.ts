import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { test } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import { GitRepository, parseStatus } from '../../src/git';

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function repository(commit = true): Promise<GitRepository> {
	const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'index-editor-'));
	git(root, 'init', '-q', '-b', 'main');
	git(root, 'config', 'user.name', 'Test');
	git(root, 'config', 'user.email', 'test@example.com');
	git(root, 'config', 'core.autocrlf', 'false');
	if (commit) {
		fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
		git(root, 'add', '.');
		git(root, 'commit', '-q', '-m', 'first');
	}
	const repo = await GitRepository.open(() => 'git', root, () => undefined);
	assert.ok(repo);
	return repo;
}

test('parseStatus reads every kind of record', () => {
	const hash = '0'.repeat(40);
	const output = [
		`1 M. N... 100644 100644 100644 ${hash} ${hash} staged file.txt`,
		`1 .D N... 100644 100644 000000 ${hash} ${hash} gone.txt`,
		`u UU N... 100644 100644 100644 100644 ${hash} ${hash} ${hash} both.txt`,
		`1 .M S.M. 160000 160000 160000 ${hash} ${hash} sub`,
		'? untracked file.txt',
		''
	].join('\0');
	assert.deepStrictEqual(parseStatus(output), [
		{ path: 'staged file.txt', staged: 'modified', unstaged: undefined, conflicted: false, submodule: false },
		{ path: 'gone.txt', staged: undefined, unstaged: 'deleted', conflicted: false, submodule: false },
		{ path: 'both.txt', conflicted: true, submodule: false },
		{ path: 'sub', staged: undefined, unstaged: 'modified', conflicted: false, submodule: true },
		{ path: 'untracked file.txt', unstaged: 'untracked', conflicted: false, submodule: false }
	]);
});

test('open finds the root from a subfolder', async () => {
	const repo = await repository();
	const sub = path.join(repo.root, 'deep', 'er');
	fs.mkdirSync(sub, { recursive: true });
	const found = await GitRepository.open(() => 'git', sub, () => undefined);
	assert.strictEqual(found?.root, repo.root);
	assert.ok(found?.gitDir.endsWith('.git'));
});

test('writeIndexContent changes the Index and nothing else', async () => {
	const repo = await repository();
	await repo.writeIndexContent('a.txt', Buffer.from('edited in index\n'));
	assert.strictEqual(git(repo.root, 'show', ':a.txt'), 'edited in index\n');
	assert.strictEqual(fs.readFileSync(path.join(repo.root, 'a.txt'), 'utf8'), 'one\ntwo\n');
	assert.strictEqual(git(repo.root, 'show', 'HEAD:a.txt'), 'one\ntwo\n');
	const [entry] = await repo.status();
	assert.strictEqual(entry.staged, 'modified');
	assert.strictEqual(entry.unstaged, 'modified');
});

test('writeIndexContent adds a path the Index does not have, with a space in its name', async () => {
	const repo = await repository();
	fs.mkdirSync(path.join(repo.root, 'sub dir'));
	fs.writeFileSync(path.join(repo.root, 'sub dir', 'n, w.txt'), 'whole\nfile\n');
	await repo.writeIndexContent('sub dir/n, w.txt', Buffer.from('whole\n'));
	assert.strictEqual(git(repo.root, 'show', ':sub dir/n, w.txt'), 'whole\n');
	assert.strictEqual((await repo.indexEntry('sub dir/n, w.txt'))?.mode, '100644');
});

test('writeIndexContent stores exact bytes and keeps the file mode', async () => {
	const repo = await repository();
	git(repo.root, 'config', 'core.autocrlf', 'true');
	git(repo.root, 'update-index', '--chmod=+x', 'a.txt');
	await repo.writeIndexContent('a.txt', Buffer.from('crlf stays\r\nhere\r\n'));
	const entry = await repo.indexEntry('a.txt');
	assert.strictEqual(entry?.mode, '100755');
	assert.deepStrictEqual(await repo.readBlob(entry!.oid), Buffer.from('crlf stays\r\nhere\r\n'));
});

test('writeIndexContent applies clean filters to a path new to the Index', async () => {
	const repo = await repository();
	git(repo.root, 'config', 'core.autocrlf', 'true');
	await repo.writeIndexContent('new.txt', Buffer.from('from\r\nworking tree\r\n'));
	const entry = await repo.indexEntry('new.txt');
	assert.deepStrictEqual(await repo.readBlob(entry!.oid), Buffer.from('from\nworking tree\n'));
});

test('writeIndexContent refuses a file with merge conflicts', async () => {
	const repo = await repository();
	git(repo.root, 'checkout', '-q', '-b', 'other');
	fs.writeFileSync(path.join(repo.root, 'a.txt'), 'other\n');
	git(repo.root, 'commit', '-q', '-am', 'other');
	git(repo.root, 'checkout', '-q', 'main');
	fs.writeFileSync(path.join(repo.root, 'a.txt'), 'main\n');
	git(repo.root, 'commit', '-q', '-am', 'main');
	assert.throws(() => execFileSync('git', ['merge', 'other'], { cwd: repo.root, stdio: 'ignore' }));
	assert.strictEqual((await repo.status())[0].conflicted, true);
	await assert.rejects(repo.writeIndexContent('a.txt', Buffer.from('x')), /merge conflicts/);
});

test('writeIndexContent waits for a held index.lock', async () => {
	const repo = await repository();
	const lock = path.join(repo.gitDir, 'index.lock');
	fs.writeFileSync(lock, '');
	setTimeout(() => fs.unlinkSync(lock), 200);
	await repo.writeIndexContent('a.txt', Buffer.from('after lock\n'));
	assert.strictEqual(git(repo.root, 'show', ':a.txt'), 'after lock\n');
});

test('concurrent Index writes are all applied', async () => {
	const repo = await repository();
	await Promise.all(Array.from({ length: 8 }, (_, i) => repo.writeIndexContent(`f${i}.txt`, Buffer.from(`${i}\n`))));
	assert.strictEqual(git(repo.root, 'ls-files').trim().split('\n').length, 9);
});

test('stage and unstage take literal paths, on a repository with and without commits', async () => {
	for (const commit of [true, false]) {
		const repo = await repository(commit);
		fs.writeFileSync(path.join(repo.root, '[x]y.txt'), 'literal\n');
		fs.writeFileSync(path.join(repo.root, 'xy.txt'), 'other\n');
		await repo.stage(['[x]y.txt']);
		assert.ok(await repo.indexEntry('[x]y.txt'));
		assert.strictEqual(await repo.indexEntry('xy.txt'), undefined);
		await repo.unstage(['[x]y.txt']);
		assert.strictEqual(await repo.indexEntry('[x]y.txt'), undefined);
		await repo.stageAll();
		assert.ok(await repo.indexEntry('xy.txt'));
		await repo.unstageAll();
		assert.strictEqual(await repo.indexEntry('xy.txt'), undefined);
	}
});

test('stage records a deleted file', async () => {
	const repo = await repository();
	fs.unlinkSync(path.join(repo.root, 'a.txt'));
	await repo.stage(['a.txt']);
	assert.strictEqual(await repo.indexEntry('a.txt'), undefined);
	assert.strictEqual((await repo.status())[0].staged, 'deleted');
});

test('restoreFromIndex brings back the Index content, not HEAD', async () => {
	const repo = await repository();
	await repo.writeIndexContent('a.txt', Buffer.from('from index\n'));
	fs.writeFileSync(path.join(repo.root, 'a.txt'), 'scratch\n');
	await repo.restoreFromIndex(['a.txt']);
	assert.strictEqual(fs.readFileSync(path.join(repo.root, 'a.txt'), 'utf8'), 'from index\n');
});

test('headEntry is undefined before the first commit and for new files', async () => {
	assert.strictEqual(await (await repository(false)).headEntry('a.txt'), undefined);
	const repo = await repository();
	assert.strictEqual(await repo.headEntry('missing.txt'), undefined);
	assert.ok(await repo.headEntry('a.txt'));
});

test('commit and amend', async () => {
	const repo = await repository();
	await repo.writeIndexContent('a.txt', Buffer.from('partial\n'));
	await repo.commit('second\n\nbody', false);
	assert.strictEqual(git(repo.root, 'log', '-1', '--format=%s'), 'second\n');
	assert.strictEqual(git(repo.root, 'show', 'HEAD:a.txt'), 'partial\n');
	await repo.commit('', true);
	assert.strictEqual(git(repo.root, 'log', '--format=%s').trim().split('\n').length, 2);
	await repo.commit('renamed', true);
	assert.strictEqual(git(repo.root, 'log', '-1', '--format=%s'), 'renamed\n');
});
