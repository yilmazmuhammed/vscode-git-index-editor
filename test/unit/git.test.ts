import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { test } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import { GitRepository, parseIdent } from '../../src/git';

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** `git status --porcelain` codes by path, e.g. `{ 'a.txt': 'MM' }`. */
function status(root: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const record of git(root, 'status', '--porcelain', '-z', '--no-renames').split('\0').filter(Boolean)) {
		result[record.slice(3)] = record.slice(0, 2);
	}
	return result;
}

async function repository(commit = true): Promise<GitRepository> {
	const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'egit-'));
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

/** A repository whose a.txt is in conflict between main and other. */
async function conflicted(): Promise<GitRepository> {
	const repo = await repository();
	git(repo.root, 'checkout', '-q', '-b', 'other');
	fs.writeFileSync(path.join(repo.root, 'a.txt'), 'other\n');
	git(repo.root, 'commit', '-q', '-am', 'other');
	git(repo.root, 'checkout', '-q', 'main');
	fs.writeFileSync(path.join(repo.root, 'a.txt'), 'main\n');
	git(repo.root, 'commit', '-q', '-am', 'main');
	assert.throws(() => execFileSync('git', ['merge', 'other'], { cwd: repo.root, stdio: 'ignore' }));
	return repo;
}

const read = (repo: GitRepository, file: string) => fs.readFileSync(path.join(repo.root, file), 'utf8');
const write = (repo: GitRepository, file: string, content: string) => fs.writeFileSync(path.join(repo.root, file), content);

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
	assert.strictEqual(read(repo, 'a.txt'), 'one\ntwo\n');
	assert.strictEqual(git(repo.root, 'show', 'HEAD:a.txt'), 'one\ntwo\n');
	assert.strictEqual(status(repo.root)['a.txt'], 'MM');
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
	const repo = await conflicted();
	assert.strictEqual(await repo.isConflicted('a.txt'), true);
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

test('resetIndexTo takes the entry of a ref, or removes a path the ref lacks', async () => {
	const repo = await repository();
	git(repo.root, 'branch', 'base');
	write(repo, 'a.txt', 'changed\n');
	write(repo, 'b.txt', 'new\n');
	git(repo.root, 'add', '.');
	git(repo.root, 'commit', '-q', '-m', 'second');
	await repo.writeIndexContent('a.txt', Buffer.from('in index\n'));

	await repo.resetIndexTo('base', 'a.txt');
	assert.strictEqual(git(repo.root, 'show', ':a.txt'), 'one\ntwo\n');
	await repo.resetIndexTo('HEAD', 'a.txt');
	assert.strictEqual(git(repo.root, 'show', ':a.txt'), 'changed\n');
	await repo.resetIndexTo('base', 'b.txt');
	assert.strictEqual(await repo.indexEntry('b.txt'), undefined);
	assert.strictEqual(read(repo, 'b.txt'), 'new\n', 'the working tree keeps the file');
});

test('stage and unstage take literal paths, on a repository with and without commits', async () => {
	for (const commit of [true, false]) {
		const repo = await repository(commit);
		write(repo, '[x]y.txt', 'literal\n');
		write(repo, 'xy.txt', 'other\n');
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
	assert.strictEqual(status(repo.root)['a.txt'], 'D ');
});

test('restoreFromIndex brings back the Index content, not HEAD', async () => {
	const repo = await repository();
	await repo.writeIndexContent('a.txt', Buffer.from('from index\n'));
	write(repo, 'a.txt', 'scratch\n');
	await repo.restoreFromIndex(['a.txt']);
	assert.strictEqual(read(repo, 'a.txt'), 'from index\n');
});

test('restoreFromSource resets Index and working tree, and removes paths HEAD lacks', async () => {
	const repo = await repository();
	await repo.writeIndexContent('a.txt', Buffer.from('staged\n'));
	write(repo, 'a.txt', 'working\n');
	write(repo, 'added.txt', 'added\n');
	git(repo.root, 'add', 'added.txt');
	await repo.restoreFromSource('HEAD', ['a.txt', 'added.txt']);
	assert.strictEqual(git(repo.root, 'show', ':a.txt'), 'one\ntwo\n');
	assert.strictEqual(read(repo, 'a.txt'), 'one\ntwo\n');
	assert.strictEqual(fs.existsSync(path.join(repo.root, 'added.txt')), false);
	assert.deepStrictEqual(status(repo.root), {});
});

test('takeConflictSide checks out one side and leaves the conflict to be staged', async () => {
	const repo = await conflicted();
	await repo.takeConflictSide('theirs', ['a.txt']);
	assert.strictEqual(read(repo, 'a.txt'), 'other\n');
	assert.strictEqual(await repo.isConflicted('a.txt'), true);
	await repo.takeConflictSide('ours', ['a.txt']);
	assert.strictEqual(read(repo, 'a.txt'), 'main\n');
});

test('takeConflictSide stages the deletion when that side deleted the file', async () => {
	const repo = await repository();
	git(repo.root, 'checkout', '-q', '-b', 'other');
	git(repo.root, 'rm', '-q', 'a.txt');
	git(repo.root, 'commit', '-q', '-m', 'delete');
	git(repo.root, 'checkout', '-q', 'main');
	write(repo, 'a.txt', 'main\n');
	git(repo.root, 'commit', '-q', '-am', 'main');
	assert.throws(() => execFileSync('git', ['merge', 'other'], { cwd: repo.root, stdio: 'ignore' }));
	await repo.takeConflictSide('theirs', ['a.txt']);
	assert.strictEqual(fs.existsSync(path.join(repo.root, 'a.txt')), false);
	assert.strictEqual(await repo.isConflicted('a.txt'), false);
});

test('assume-unchanged is set, listed and cleared', async () => {
	const repo = await repository();
	await repo.setAssumeUnchanged(['a.txt'], true);
	write(repo, 'a.txt', 'hidden change\n');
	assert.deepStrictEqual(await repo.assumeUnchangedFiles(), ['a.txt']);
	assert.deepStrictEqual(status(repo.root), {});
	await repo.setAssumeUnchanged(['a.txt'], false);
	assert.deepStrictEqual(await repo.assumeUnchangedFiles(), []);
	assert.strictEqual(status(repo.root)['a.txt'], ' M');
});

test('untrack removes a file from the Index and keeps it on disk', async () => {
	const repo = await repository();
	await repo.untrack(['a.txt']);
	assert.strictEqual(await repo.indexEntry('a.txt'), undefined);
	assert.strictEqual(read(repo, 'a.txt'), 'one\ntwo\n');
	const records = git(repo.root, 'status', '--porcelain', '-z').split('\0');
	assert.ok(records.includes('D  a.txt'), 'the deletion is staged');
	assert.ok(records.includes('?? a.txt'), 'the file is now untracked');
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
	await repo.commit({ message: 'second\n\nbody', amend: false, signOff: false });
	assert.strictEqual(git(repo.root, 'log', '-1', '--format=%s'), 'second\n');
	assert.strictEqual(git(repo.root, 'show', 'HEAD:a.txt'), 'partial\n');
	await repo.commit({ message: '', amend: true, signOff: false });
	assert.strictEqual(git(repo.root, 'log', '--format=%s').trim().split('\n').length, 2);
	await repo.commit({ message: 'renamed', amend: true, signOff: false });
	assert.strictEqual(git(repo.root, 'log', '-1', '--format=%s'), 'renamed\n');
	assert.strictEqual(await repo.headMessage(), 'renamed');
});

test('commit sets author, committer and sign-off', async () => {
	const repo = await repository();
	await repo.writeIndexContent('a.txt', Buffer.from('signed\n'));
	await repo.commit({
		message: 'with people',
		amend: false,
		signOff: true,
		author: 'Ayşe Yazar <ayse@example.com>',
		committer: 'Cem Commit <cem@example.com>'
	});
	assert.strictEqual(git(repo.root, 'log', '-1', '--format=%an|%ae|%cn|%ce'), 'Ayşe Yazar|ayse@example.com|Cem Commit|cem@example.com\n');
	assert.match(git(repo.root, 'log', '-1', '--format=%B'), /Signed-off-by: Cem Commit <cem@example.com>/);
});

test('commit keeps lines that start with # in the message', async () => {
	const repo = await repository();
	await repo.writeIndexContent('a.txt', Buffer.from('issue\n'));
	await repo.commit({ message: 'Fix crash\n\n#123 is fixed', amend: false, signOff: false });
	assert.strictEqual(await repo.headMessage(), 'Fix crash\n\n#123 is fixed');
});

test('parseIdent splits Name <email>', () => {
	assert.deepStrictEqual(parseIdent(' Ad Soyad  <ad@example.com> '), { name: 'Ad Soyad', email: 'ad@example.com' });
	assert.strictEqual(parseIdent('no email'), undefined);
	assert.strictEqual(parseIdent('<only@example.com>'), undefined);
});

test('config, userIdent and commitTemplate', async () => {
	const repo = await repository();
	assert.strictEqual(await repo.config('no.such-key'), undefined);
	assert.strictEqual(await repo.userIdent(), 'Test <test@example.com>');
	assert.strictEqual(await repo.commitTemplate(), undefined);
	write(repo, 'template.txt', 'Summary\n\n# explain why\n');
	git(repo.root, 'config', 'commit.template', 'template.txt');
	assert.strictEqual(await repo.commitTemplate(), 'Summary\n\n# explain why\n');
});

test('operation reports a merge and a rebase in progress', async () => {
	const repo = await conflicted();
	assert.strictEqual(await repo.operation(), 'merge');
	assert.match((await repo.preparedMessage()) ?? '', /Merge branch 'other'/);
	await repo.mergeAbort();
	assert.strictEqual(await repo.operation(), 'none');

	assert.throws(() => execFileSync('git', ['rebase', 'other'], { cwd: repo.root, stdio: 'ignore' }));
	assert.strictEqual(await repo.operation(), 'rebase');
	write(repo, 'a.txt', 'resolved\n');
	git(repo.root, 'add', 'a.txt');
	await repo.rebaseContinue();
	assert.strictEqual(await repo.operation(), 'none');
	assert.strictEqual(git(repo.root, 'log', '-1', '--format=%s'), 'main\n');
});

test('rebaseAbort returns to the state before the rebase', async () => {
	const repo = await conflicted();
	await repo.mergeAbort();
	const before = git(repo.root, 'rev-parse', 'HEAD');
	assert.throws(() => execFileSync('git', ['rebase', 'other'], { cwd: repo.root, stdio: 'ignore' }));
	await repo.rebaseAbort();
	assert.strictEqual(git(repo.root, 'rev-parse', 'HEAD'), before);
});

test('isHeadPublished tells whether a remote-tracking branch contains HEAD', async () => {
	const repo = await repository();
	const remote = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'egit-remote-'));
	git(remote, 'init', '-q', '--bare');
	git(repo.root, 'remote', 'add', 'origin', remote);
	assert.strictEqual(await repo.isHeadPublished(), false);
	git(repo.root, 'push', '-q', 'origin', 'main');
	assert.strictEqual(await repo.isHeadPublished(), true);
	write(repo, 'a.txt', 'local only\n');
	git(repo.root, 'commit', '-q', '-am', 'local');
	assert.strictEqual(await repo.isHeadPublished(), false);
});
