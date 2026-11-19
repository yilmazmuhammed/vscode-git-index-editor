import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { test } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import { GitRepository } from '../../src/git';
import {
	buildRefTree, diffRefs, isRefspec, parseRefs, parseRefSnapshot, parseRemoteConfig, recentBranches, REF_FORMAT, REF_PATTERNS,
	RefInfo, RefTreeNode, splitRefspecs, suggestBranchName
} from '../../src/repositories/model';

const ref = (fields: string[]) => fields.join('\0');

test('parseRefs reads local branches with tracking, remote branches and tags', () => {
	const hash = 'a'.repeat(40);
	const output = [
		ref(['refs/heads/main', hash, 'origin/main', 'ahead 2, behind 1', '*', 'Subject with\ttab']),
		ref(['refs/heads/feature/x', hash, 'origin/feature/x', 'gone', ' ', 'feature']),
		ref(['refs/heads/plain', hash, '', '', ' ', 'no upstream']),
		ref(['refs/remotes/origin/HEAD', hash, '', '', ' ', 'symbolic']),
		ref(['refs/remotes/origin/main', hash, '', '', ' ', 'remote main']),
		ref(['refs/remotes/team/a/feature', hash, '', '', ' ', 'remote with a slash in its name']),
		ref(['refs/tags/v1.0', hash, '', '', ' ', 'tag']),
		''
	].join('\n');
	const refs = parseRefs(output, ['origin', 'team/a']);
	assert.deepStrictEqual(refs.map(r => `${r.kind}:${r.name}`), [
		'local:main', 'local:feature/x', 'local:plain', 'remote:origin/main', 'remote:team/a/feature', 'tag:v1.0'
	]);
	const [main, feature, plain, originMain, team] = refs;
	assert.strictEqual(main.isHead, true);
	assert.strictEqual(main.upstream, 'origin/main');
	assert.strictEqual(main.ahead, 2);
	assert.strictEqual(main.behind, 1);
	assert.strictEqual(main.subject, 'Subject with\ttab');
	assert.strictEqual(feature.upstreamGone, true);
	assert.strictEqual(plain.upstream, undefined);
	assert.strictEqual(originMain.remote, 'origin');
	assert.strictEqual(originMain.remoteBranch, 'main');
	assert.strictEqual(team.remote, 'team/a');
	assert.strictEqual(team.remoteBranch, 'feature');
});

test('parseRefs reads what git for-each-ref prints for a real repository', async () => {
	const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'index-editor-refs-'));
	const remote = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'index-editor-refs-remote-'));
	const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
	git(remote, 'init', '-q', '--bare');
	git(root, 'init', '-q', '-b', 'main');
	git(root, 'config', 'user.name', 'Test');
	git(root, 'config', 'user.email', 'test@example.com');
	fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
	git(root, 'add', '.');
	git(root, 'commit', '-q', '-m', 'first');
	git(root, 'remote', 'add', 'origin', remote);
	git(root, 'push', '-q', '-u', 'origin', 'main');
	fs.writeFileSync(path.join(root, 'a.txt'), 'b\n');
	git(root, 'commit', '-q', '-am', 'second');
	git(root, 'branch', 'topic/one');
	const repository = await GitRepository.open(() => 'git', root, () => undefined);
	const refs = parseRefs(await repository!.forEachRef(REF_FORMAT, REF_PATTERNS), ['origin']);
	const main = refs.find(r => r.name === 'main')!;
	assert.strictEqual(main.isHead, true);
	assert.strictEqual(main.upstream, 'origin/main');
	assert.strictEqual(main.ahead, 1);
	assert.strictEqual(main.behind, 0);
	assert.strictEqual(main.subject, 'second');
	assert.ok(refs.some(r => r.kind === 'local' && r.name === 'topic/one' && !r.isHead));
	assert.ok(refs.some(r => r.kind === 'remote' && r.name === 'origin/main'));

	const remotes = parseRemoteConfig(await repository!.configRegexp('^remote\\.'));
	assert.deepStrictEqual(remotes.map(r => [r.name, r.url, r.fetch]), [['origin', remote, ['+refs/heads/*:refs/remotes/origin/*']]]);
	assert.strictEqual(await repository!.configRegexp('^nothing\\.'), '');
});

test('parseRemoteConfig collects multi-valued keys and keeps dotted remote names', () => {
	const output = [
		'remote.origin.url\nhttps://example.com/a.git',
		'remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*',
		'remote.origin.pushurl\nhttps://one.example.com/a.git',
		'remote.origin.pushurl\nhttps://two.example.com/a.git',
		'remote.origin.push\nrefs/heads/main:refs/for/main',
		'remote.origin.tagopt\n--no-tags',
		'remote.origin.prune\ntrue',
		'remote.my.mirror.url\n/srv/mirror.git',
		''
	].join('\0');
	const [origin, mirror] = parseRemoteConfig(output);
	assert.deepStrictEqual(origin, {
		name: 'origin',
		url: 'https://example.com/a.git',
		pushUrls: ['https://one.example.com/a.git', 'https://two.example.com/a.git'],
		fetch: ['+refs/heads/*:refs/remotes/origin/*'],
		push: ['refs/heads/main:refs/for/main'],
		tagOpt: '--no-tags',
		prune: 'true'
	});
	assert.strictEqual(mirror.name, 'my.mirror');
	assert.strictEqual(mirror.url, '/srv/mirror.git');
});

test('recentBranches reads checkouts from the reflog, newest first, existing branches only', () => {
	const subjects = [
		'checkout: moving from feature to main',
		'commit: something',
		'checkout: moving from main to feature',
		'checkout: moving from deleted to main',
		'checkout: moving from main to 1234567'
	];
	assert.deepStrictEqual(recentBranches(subjects, new Set(['main', 'feature'])), ['main', 'feature']);
	assert.deepStrictEqual(recentBranches(subjects, new Set(['main', 'feature']), 1), ['main']);
});

function labels(nodes: readonly RefTreeNode[], depth = 0): string[] {
	return nodes.flatMap(node => node.type === 'folder'
		? [`${'  '.repeat(depth)}${node.label}/`, ...labels(node.children, depth + 1)]
		: [`${'  '.repeat(depth)}${node.label}`]);
}

test('buildRefTree groups at "/" or lists flat, sorted naturally', () => {
	const refs = ['main', 'feature/b', 'feature/a', 'release/v10', 'release/v9', 'Zeta'].map((name): RefInfo =>
		({ kind: 'local', name, fullName: `refs/heads/${name}`, commit: '0', isHead: false, subject: '' }));
	assert.deepStrictEqual(labels(buildRefTree(refs, true)), [
		'feature/', '  a', '  b', 'release/', '  v9', '  v10', 'main', 'Zeta'
	]);
	assert.deepStrictEqual(labels(buildRefTree(refs, false)), ['feature/a', 'feature/b', 'main', 'release/v9', 'release/v10', 'Zeta']);
});

test('diffRefs and parseRefSnapshot tell what a fetch changed', () => {
	const before = parseRefSnapshot('refs/remotes/origin/main\0aaa\nrefs/remotes/origin/old\0bbb\nrefs/tags/v1\0ccc\n');
	const after = parseRefSnapshot('refs/remotes/origin/main\0ddd\nrefs/remotes/origin/new\0eee\nrefs/tags/v1\0ccc\r\n');
	assert.deepStrictEqual(diffRefs(before, after), {
		updated: ['refs/remotes/origin/main'],
		created: ['refs/remotes/origin/new'],
		deleted: ['refs/remotes/origin/old']
	});
});

test('suggestBranchName follows EGit', () => {
	assert.strictEqual(suggestBranchName({ kind: 'remote', name: 'origin/feature/x', remoteBranch: 'feature/x' }), 'feature/x');
	assert.strictEqual(suggestBranchName({ kind: 'tag', name: 'v1.0' }), 'v1.0-branch');
	assert.strictEqual(suggestBranchName({ kind: 'local', name: 'main' }), '');
	assert.strictEqual(suggestBranchName(undefined), '');
});

test('isRefspec and splitRefspecs', () => {
	for (const valid of ['main', 'HEAD:refs/heads/main', '+refs/heads/*:refs/remotes/origin/*', ':refs/heads/old', '+:refs/heads/x', ':', 'refs/heads/a:']) {
		assert.ok(isRefspec(valid), valid);
	}
	for (const invalid of ['', '+', 'a:b:c', 'has space', '::']) {
		assert.ok(!isRefspec(invalid), invalid);
	}
	assert.deepStrictEqual(splitRefspecs('  HEAD:refs/heads/a\n+b:c   :d '), ['HEAD:refs/heads/a', '+b:c', ':d']);
});
