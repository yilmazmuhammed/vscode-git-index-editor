import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import type { Repository } from '../../src/repository';
import type { Entry, Node } from '../../src/staging/entries';
import { baseRefOf } from '../../src/uris';

const root = vscode.workspace.workspaceFolders![0].uri.fsPath;

const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });

/**
 * For commands that rewrite .git/config. The built-in Git extension reads that file in this same
 * extension host when it changes, and on Windows a file that is open cannot be replaced. So retry,
 * and wait asynchronously, letting the extension host finish its read in the meantime.
 */
async function gitConfig(...args: string[]): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			git(...args);
			return;
		} catch (error) {
			const stderr = String((error as { stderr?: unknown }).stderr ?? '');
			if (attempt >= 30 || !/could not (write|lock) config file|Permission denied/.test(stderr)) {
				throw error;
			}
			await sleep(100);
		}
	}
}

const indexOf = (file: string) => git('show', `:${file}`);
const headOf = (file: string) => git('show', `HEAD:${file}`);
const uriOf = (file: string) => vscode.Uri.file(path.join(root, file));
const write = (file: string, content: string) => fs.writeFileSync(path.join(root, file), content);
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function until(what: string, condition: () => boolean | Promise<boolean>, timeout = 8000): Promise<void> {
	const end = Date.now() + timeout;
	while (!(await condition())) {
		if (Date.now() > end) {
			throw new Error(`timed out waiting until ${what}`);
		}
		await sleep(25);
	}
}

function commitAll(file: string, content: string): void {
	write(file, content);
	git('add', '--', file);
	git('commit', '-q', '-m', `add ${file}`);
}

const sideEditor = (scheme: string) => vscode.window.visibleTextEditors.find(editor => editor.document.uri.scheme === scheme);
const activeDiffInput = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input as vscode.TabInputTextDiff | undefined;

async function openedDiff(command: string, file: string): Promise<void> {
	await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	await vscode.commands.executeCommand(command, uriOf(file));
	await until('both sides of the diff are visible', () => vscode.window.visibleTextEditors.length >= 2);
}

function select(editor: vscode.TextEditor, startLine: number, endLine = startLine, endCharacter = 0): void {
	const empty = startLine === endLine && endCharacter === 0;
	editor.selection = empty
		? new vscode.Selection(startLine, 0, startLine, 0)
		: new vscode.Selection(startLine, 0, endLine, endCharacter);
}

async function typeInto(focusCommand: string, text: string): Promise<void> {
	await vscode.commands.executeCommand(focusCommand);
	await sleep(150);
	await vscode.commands.executeCommand('type', { text });
	await sleep(150);
}

/** VS Code applies a read-only change when it reloads the document, which it does not do at once. */
const READ_ONLY_SETTLE = 3000;

async function setInline(inline: boolean): Promise<void> {
	await vscode.workspace.getConfiguration('diffEditor')
		.update('renderSideBySide', inline ? false : undefined, vscode.ConfigurationTarget.Global);
}

interface Context {
	readonly extension: ExtensionApi;
	readonly repository: Repository;
}

/** Makes the built-in Git extension and the Staging view catch up with changes made on the command line. */
async function synced({ extension, repository }: Context): Promise<void> {
	await repository.refresh();
	extension.staging.update();
}

const names = (entries: readonly Entry[]) => entries.map(entry => entry.path).sort();
const fileNode = (entry: Entry): Node => ({ type: 'file', entry });
const find = (context: Context, list: Entry['list'], file: string) =>
	context.extension.staging.entries(list).find(entry => entry.path === file);

const tests: [string, (context: Context) => Promise<void>][] = [
	['the Staging view lists unstaged and staged changes of the same file', async context => {
		commitAll('groups.txt', 'one\n');
		write('groups.txt', 'one\ntwo\n');
		git('add', 'groups.txt');
		write('groups.txt', 'one\ntwo\nthree\n');
		write('untracked.txt', 'new\n');
		await synced(context);
		const { staging } = context.extension;
		assert.deepStrictEqual(names(staging.entries('unstaged')), ['groups.txt', 'untracked.txt']);
		assert.deepStrictEqual(names(staging.entries('staged')), ['groups.txt']);
		assert.strictEqual(find(context, 'unstaged', 'groups.txt')?.partial, true);
		assert.strictEqual(find(context, 'unstaged', 'untracked.txt')?.kind, 'untracked');
		assert.strictEqual(staging.views.unstaged.title, 'Unstaged Changes (2)');

		await vscode.workspace.getConfiguration('indexEditor.staging').update('showUntracked', false, vscode.ConfigurationTarget.Global);
		try {
			await until('untracked files are hidden', () => !find(context, 'unstaged', 'untracked.txt'));
		} finally {
			await vscode.workspace.getConfiguration('indexEditor.staging').update('showUntracked', undefined, vscode.ConfigurationTarget.Global);
		}
		git('reset', '-q', 'groups.txt');
		git('checkout', '--', 'groups.txt');
		fs.unlinkSync(path.join(root, 'untracked.txt'));
		await synced(context);
	}],

	['the filter narrows both lists and the titles count what is shown', async context => {
		write('one.md', 'a\n');
		write('two.txt', 'b\n');
		await synced(context);
		const { staging } = context.extension;
		staging.setFilter('*.md');
		try {
			assert.strictEqual(staging.views.unstaged.title, 'Unstaged Changes (1/2)');
			assert.strictEqual(staging.views.staged.title, 'Staged Changes (0/0)');
		} finally {
			staging.setFilter('');
		}
		assert.strictEqual(staging.views.unstaged.title, 'Unstaged Changes (2)');
		fs.unlinkSync(path.join(root, 'one.md'));
		fs.unlinkSync(path.join(root, 'two.txt'));
		await synced(context);
	}],

	['Staging commands and drag and drop stage and unstage files', async context => {
		commitAll('scm.txt', 'a\n');
		write('scm.txt', 'b\n');
		await synced(context);
		const unstaged = find(context, 'unstaged', 'scm.txt')!;
		await vscode.commands.executeCommand('indexEditor.stageFile', fileNode(unstaged));
		assert.strictEqual(indexOf('scm.txt'), 'b\n');
		await synced(context);
		const staged = find(context, 'staged', 'scm.txt')!;
		await vscode.commands.executeCommand('indexEditor.unstageFile', fileNode(staged), [fileNode(staged)]);
		assert.strictEqual(indexOf('scm.txt'), 'a\n');

		await context.extension.staging.drop('staged', [unstaged]);
		assert.strictEqual(indexOf('scm.txt'), 'b\n');
		await context.extension.staging.drop('unstaged', [staged]);
		assert.strictEqual(indexOf('scm.txt'), 'a\n');
		git('checkout', '--', 'scm.txt');
		await synced(context);
	}],

	['the 0.1.0 file commands still take file URIs', async context => {
		commitAll('legacy.txt', 'a\n');
		write('legacy.txt', 'b\n');
		write('legacy-new.txt', 'new\n');
		await synced(context);
		await vscode.commands.executeCommand('indexEditor.stageFile', uriOf('legacy.txt'), [uriOf('legacy.txt'), uriOf('legacy-new.txt')]);
		assert.strictEqual(indexOf('legacy.txt'), 'b\n');
		assert.strictEqual(indexOf('legacy-new.txt'), 'new\n');
		await vscode.commands.executeCommand('indexEditor.unstageFile', uriOf('legacy.txt'));
		assert.strictEqual(indexOf('legacy.txt'), 'a\n');
		await vscode.commands.executeCommand('indexEditor.openFile', uriOf('legacy.txt'));
		await until('the file opens', () => vscode.window.activeTextEditor?.document.uri.fsPath === uriOf('legacy.txt').fsPath);
		const commands = await vscode.commands.getCommands(true);
		for (const id of ['stageFile', 'unstageFile', 'discardFile', 'openFile', 'stageAll', 'unstageAll', 'refresh', 'commit', 'commitAmend',
			'openUnstagedDiff', 'openStagedDiff', 'switchDiff', 'stageChange', 'unstageChange', 'discardChange']) {
			assert.ok(commands.includes(`indexEditor.${id}`), `indexEditor.${id} is registered`);
		}
		git('reset', '-q');
		git('checkout', '--', 'legacy.txt');
		fs.unlinkSync(path.join(root, 'legacy-new.txt'));
		await synced(context);
	}],

	['Ignore writes the file to the .gitignore of its folder', async context => {
		fs.mkdirSync(path.join(root, 'build'), { recursive: true });
		write('build/out.log', 'log\n');
		await synced(context);
		const entry = find(context, 'unstaged', 'build/out.log')!;
		await vscode.commands.executeCommand('indexEditor.staging.ignore', fileNode(entry));
		assert.strictEqual(read('build/.gitignore'), '/out.log\n');
		await synced(context);
		assert.ok(!find(context, 'unstaged', 'build/out.log'));
		fs.rmSync(path.join(root, 'build'), { recursive: true });
		await synced(context);
	}],

	['Assume Unchanged hides a file until it is cleared', async context => {
		commitAll('assumed.txt', 'a\n');
		write('assumed.txt', 'b\n');
		await synced(context);
		await vscode.commands.executeCommand('indexEditor.staging.assumeUnchanged', fileNode(find(context, 'unstaged', 'assumed.txt')!));
		await synced(context);
		assert.ok(!find(context, 'unstaged', 'assumed.txt'));
		assert.match(git('ls-files', '-v', 'assumed.txt'), /^h /);
		git('update-index', '--no-assume-unchanged', 'assumed.txt');
		git('checkout', '--', 'assumed.txt');
		await synced(context);
	}],

	['saving the Index side of the unstaged diff updates only the Index', async () => {
		commitAll('save.txt', 'head\n');
		write('save.txt', 'working tree\n');
		await openedDiff('indexEditor.openUnstagedDiff', 'save.txt');
		const input = activeDiffInput()!;
		assert.strictEqual(input.original.scheme, 'file');
		assert.strictEqual(input.modified.scheme, 'git-index');

		await typeInto('workbench.action.compareEditor.focusPrimarySide', 'typed ');
		const index = sideEditor('git-index')!.document;
		assert.strictEqual(index.getText(), 'typed head\n');
		assert.ok(index.isDirty);
		assert.strictEqual(indexOf('save.txt'), 'head\n', 'nothing reaches Git before saving');

		await index.save();
		assert.strictEqual(indexOf('save.txt'), 'typed head\n');
		assert.strictEqual(read('save.txt'), 'working tree\n');
		assert.strictEqual(headOf('save.txt'), 'head\n');
	}],

	['the working tree side of the unstaged diff is editable too', async () => {
		await openedDiff('indexEditor.openUnstagedDiff', 'save.txt');
		await typeInto('workbench.action.compareEditor.focusSecondarySide', 'left ');
		const working = sideEditor('file')!.document;
		assert.strictEqual(working.getText(), 'left working tree\n');
		await working.save();
		assert.strictEqual(read('save.txt'), 'left working tree\n');
	}],

	['the staged diff edits the Index against a read-only HEAD', async () => {
		await openedDiff('indexEditor.openStagedDiff', 'save.txt');
		const input = activeDiffInput()!;
		assert.strictEqual(input.original.scheme, 'git');
		assert.strictEqual(baseRefOf(input.original), 'HEAD');
		assert.strictEqual(input.modified.scheme, 'git-index');

		await typeInto('workbench.action.compareEditor.focusSecondarySide', 'nope ');
		assert.strictEqual(sideEditor('git')!.document.getText(), 'head\n');
		assert.strictEqual(sideEditor('git')!.document.isDirty, false);

		await typeInto('workbench.action.compareEditor.focusPrimarySide', 'more ');
		const index = sideEditor('git-index')!.document;
		assert.strictEqual(index.getText(), 'more typed head\n');
		await index.save();
		assert.strictEqual(indexOf('save.txt'), 'more typed head\n');
		assert.strictEqual(read('save.txt'), 'left working tree\n');
	}],

	['the staged diff of a new file shows an empty base and still counts as staged', async () => {
		write('brand-new.txt', 'fresh\n');
		git('add', 'brand-new.txt');
		await openedDiff('indexEditor.openStagedDiff', 'brand-new.txt');
		const input = activeDiffInput()!;
		assert.strictEqual(input.original.scheme, 'git-index-empty');
		assert.strictEqual(baseRefOf(input.original), 'HEAD');
		assert.strictEqual(sideEditor('git-index-empty')!.document.getText(), '');
		assert.strictEqual(sideEditor('git-index')!.document.getText(), 'fresh\n');

		await vscode.commands.executeCommand('workbench.action.compareEditor.focusPrimarySide');
		select(sideEditor('git-index')!, 0);
		await vscode.commands.executeCommand('indexEditor.unstageChange');
		assert.strictEqual(indexOf('brand-new.txt'), '', 'unstaging the only hunk leaves the file empty in the Index');
		git('rm', '-q', '-f', '--cached', 'brand-new.txt');
		fs.unlinkSync(path.join(root, 'brand-new.txt'));
	}],

	['stageChange takes only the hunk under the cursor', async () => {
		commitAll('hunks.txt', 'a\nb\nc\nd\ne\nf\ng\n');
		write('hunks.txt', 'A\nb\nc\nd\ne\nf\nG\n');
		await openedDiff('indexEditor.openUnstagedDiff', 'hunks.txt');
		await until('the context key is set', async () => (await vscode.commands.getCommands(true)).includes('indexEditor.stageChange'));
		select(sideEditor('file')!, 6);
		await vscode.commands.executeCommand('workbench.action.compareEditor.focusSecondarySide');
		await vscode.commands.executeCommand('indexEditor.stageChange');
		assert.strictEqual(indexOf('hunks.txt'), 'a\nb\nc\nd\ne\nf\nG\n');
		assert.strictEqual(read('hunks.txt'), 'A\nb\nc\nd\ne\nf\nG\n');
		const index = sideEditor('git-index')!.document;
		await until('the open Index document reloads', () => index.getText().endsWith('G\n'));
		assert.strictEqual(index.isDirty, false);
	}],

	['stageChange takes selected lines of a hunk', async () => {
		commitAll('lines.txt', 'x\ny\n');
		write('lines.txt', 'x\nn1\nn2\nn3\ny\n');
		await openedDiff('indexEditor.openUnstagedDiff', 'lines.txt');
		await vscode.commands.executeCommand('workbench.action.compareEditor.focusSecondarySide');
		select(sideEditor('file')!, 2, 2, 2);
		await vscode.commands.executeCommand('indexEditor.stageChange');
		assert.strictEqual(indexOf('lines.txt'), 'x\nn2\ny\n');
	}],

	['unstageChange returns a hunk of the Index to its HEAD content', async () => {
		commitAll('unstage.txt', '1\n2\n3\n4\n5\n6\n7\n');
		write('unstage.txt', 'one\n2\n3\n4\n5\n6\nseven\n');
		git('add', 'unstage.txt');
		await openedDiff('indexEditor.openStagedDiff', 'unstage.txt');
		await vscode.commands.executeCommand('workbench.action.compareEditor.focusPrimarySide');
		select(sideEditor('git-index')!, 0);
		await vscode.commands.executeCommand('indexEditor.unstageChange');
		assert.strictEqual(indexOf('unstage.txt'), '1\n2\n3\n4\n5\n6\nseven\n');
		assert.strictEqual(read('unstage.txt'), 'one\n2\n3\n4\n5\n6\nseven\n');
	}],

	['resetIndexToBase and stageWholeFile work on the file of the active diff', async () => {
		await openedDiff('indexEditor.openStagedDiff', 'unstage.txt');
		await vscode.commands.executeCommand('indexEditor.resetIndexToBase');
		assert.strictEqual(indexOf('unstage.txt'), '1\n2\n3\n4\n5\n6\n7\n');
		await openedDiff('indexEditor.openUnstagedDiff', 'unstage.txt');
		await vscode.commands.executeCommand('indexEditor.stageWholeFile');
		assert.strictEqual(indexOf('unstage.txt'), 'one\n2\n3\n4\n5\n6\nseven\n');
	}],

	['stageChange joins unsaved Index edits instead of overwriting them', async () => {
		commitAll('dirty.txt', 'a\nb\nc\nd\ne\nf\n');
		write('dirty.txt', 'a\nb\nc\nd\ne\nF\n');
		await openedDiff('indexEditor.openUnstagedDiff', 'dirty.txt');
		await vscode.commands.executeCommand('workbench.action.compareEditor.focusPrimarySide');
		select(sideEditor('git-index')!, 0);
		await typeInto('workbench.action.compareEditor.focusPrimarySide', 'edit ');
		const index = sideEditor('git-index')!.document;
		assert.ok(index.isDirty);
		await vscode.commands.executeCommand('workbench.action.compareEditor.focusSecondarySide');
		select(sideEditor('file')!, 5);
		await vscode.commands.executeCommand('indexEditor.stageChange');
		assert.strictEqual(index.getText(), 'edit a\nb\nc\nd\ne\nF\n');
		assert.strictEqual(indexOf('dirty.txt'), 'a\nb\nc\nd\ne\nf\n', 'nothing is written until the user saves');
		await index.save();
		assert.strictEqual(indexOf('dirty.txt'), 'edit a\nb\nc\nd\ne\nF\n');
	}],

	['discardChange changes the working tree document without saving it', async () => {
		commitAll('discard.txt', 'a\nb\n');
		write('discard.txt', 'A\nb\n');
		await openedDiff('indexEditor.openUnstagedDiff', 'discard.txt');
		await vscode.commands.executeCommand('workbench.action.compareEditor.focusSecondarySide');
		select(sideEditor('file')!, 0);
		await vscode.commands.executeCommand('indexEditor.discardChange');
		const working = sideEditor('file')!.document;
		assert.strictEqual(working.getText(), 'a\nb\n');
		assert.ok(working.isDirty);
		assert.strictEqual(read('discard.txt'), 'A\nb\n');
		await vscode.commands.executeCommand('workbench.action.files.revert');
	}],

	['part of an untracked file can be staged', async () => {
		write('fresh.txt', 'keep\nleave\n');
		await openedDiff('indexEditor.openUnstagedDiff', 'fresh.txt');
		await vscode.commands.executeCommand('workbench.action.compareEditor.focusSecondarySide');
		select(sideEditor('file')!, 0, 0, 4);
		await vscode.commands.executeCommand('indexEditor.stageChange');
		assert.strictEqual(indexOf('fresh.txt'), 'keep\n');
		assert.ok(git('ls-files', '--stage', 'fresh.txt').startsWith('100644'));
	}],

	['autocrlf: staging from a CRLF working tree keeps LF in the Index', async () => {
		commitAll('crlf.txt', 'a\nb\nc\nd\ne\n');
		await gitConfig('config', 'core.autocrlf', 'true');
		try {
			write('crlf.txt', 'a\r\nb\r\nc\r\nd\r\nE\r\n');
			await openedDiff('indexEditor.openUnstagedDiff', 'crlf.txt');
			await vscode.commands.executeCommand('workbench.action.compareEditor.focusSecondarySide');
			select(sideEditor('file')!, 4);
			await vscode.commands.executeCommand('indexEditor.stageChange');
			assert.strictEqual(indexOf('crlf.txt'), 'a\nb\nc\nd\nE\n');
		} finally {
			await gitConfig('config', 'core.autocrlf', 'false');
		}
	}],

	['an open Index document follows changes made outside the editor', async context => {
		commitAll('outside.txt', 'old\n');
		write('outside.txt', 'new\n');
		await openedDiff('indexEditor.openUnstagedDiff', 'outside.txt');
		const index = sideEditor('git-index')!.document;
		assert.strictEqual(index.getText(), 'old\n');
		git('add', 'outside.txt');
		await until('the Index document reloads', () => index.getText() === 'new\n');
		await until('the file leaves the unstaged list', () => !find(context, 'unstaged', 'outside.txt'));
	}],

	['a file deleted from the working tree can be compared with the Index', async () => {
		commitAll('deleted.txt', 'still here\n');
		fs.unlinkSync(path.join(root, 'deleted.txt'));
		await openedDiff('indexEditor.openUnstagedDiff', 'deleted.txt');
		assert.strictEqual(sideEditor('git-index')!.document.getText(), 'still here\n');
		assert.strictEqual(sideEditor('git-index-empty')!.document.getText(), '');
		git('checkout', '--', 'deleted.txt');
	}],

	['switchDiff moves between the two diffs of a file', async () => {
		await openedDiff('indexEditor.openUnstagedDiff', 'save.txt');
		await vscode.commands.executeCommand('indexEditor.switchDiff');
		await until('the staged diff is active', () => activeDiffInput()?.original.scheme === 'git');
		await vscode.commands.executeCommand('indexEditor.switchDiff');
		await until('the unstaged diff is active', () => activeDiffInput()?.original.scheme === 'file');
	}],

	['the staged diff compares with the upstream branch when chosen, and the title button switches back', async context => {
		const remote = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'egit-it-remote-'));
		execFileSync('git', ['init', '-q', '--bare', remote]);
		await gitConfig('remote', 'add', 'origin', remote);
		commitAll('upstream.txt', 'remote\n');
		await gitConfig('push', '-q', '-u', 'origin', 'main');
		write('upstream.txt', 'local\n');
		git('commit', '-q', '-am', 'local only');
		write('upstream.txt', 'staged\n');
		git('add', 'upstream.txt');
		await synced(context);
		await until('the upstream is known', () => context.repository.api.state.HEAD?.upstream?.name === 'main');

		const config = vscode.workspace.getConfiguration('indexEditor.staging');
		await config.update('stagedCompareBase', 'upstream', vscode.ConfigurationTarget.Global);
		try {
			await openedDiff('indexEditor.openStagedDiff', 'upstream.txt');
			assert.strictEqual(baseRefOf(activeDiffInput()!.original), 'refs/remotes/origin/main');
			await until('the upstream content loads', () => sideEditor('git')?.document.getText() === 'remote\n');

			await vscode.commands.executeCommand('indexEditor.resetIndexToBase');
			assert.strictEqual(indexOf('upstream.txt'), 'remote\n');
			git('add', 'upstream.txt');

			await vscode.commands.executeCommand('indexEditor.toggleStagedBase');
			await until('the base is HEAD', () => baseRefOf(activeDiffInput()!.original) === 'HEAD');
			await until('the HEAD content loads', () => sideEditor('git')?.document.getText() === 'local\n');
			assert.strictEqual(vscode.window.tabGroups.activeTabGroup.tabs.length, 1, 'the upstream diff was replaced');
		} finally {
			await config.update('stagedCompareBase', undefined, vscode.ConfigurationTarget.Global);
		}
	}],

	['diffs default to side by side, even in a narrow window', async () => {
		const diffEditor = vscode.workspace.getConfiguration('diffEditor');
		assert.strictEqual(diffEditor.get('renderSideBySide'), true);
		assert.strictEqual(diffEditor.get('useInlineViewWhenSpaceIsLimited'), false);
	}],

	['inline mode refuses to open a diff', async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await setInline(true);
		try {
			// not awaited: the command waits for the answer to its notification
			void vscode.commands.executeCommand('indexEditor.openUnstagedDiff', uriOf('save.txt'));
			void vscode.commands.executeCommand('indexEditor.openStagedDiff', uriOf('save.txt'));
			await sleep(500);
			assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab, undefined);
		} finally {
			await setInline(false);
		}
	}],

	['switching to inline makes an open diff inactive and its Index read-only', async () => {
		commitAll('inline.txt', 'a\nb\n');
		write('inline.txt', 'A\nb\n');
		await openedDiff('indexEditor.openUnstagedDiff', 'inline.txt');
		const index = sideEditor('git-index')!.document;
		await vscode.commands.executeCommand('workbench.action.compareEditor.focusSecondarySide');
		select(sideEditor('file')!, 0);

		await setInline(true);
		try {
			await sleep(300);
			await vscode.commands.executeCommand('indexEditor.stageChange');
			assert.strictEqual(indexOf('inline.txt'), 'a\nb\n', 'stageChange does nothing');
			await sleep(READ_ONLY_SETTLE);
			await typeInto('workbench.action.compareEditor.focusPrimarySide', 'typed ');
			assert.strictEqual(index.getText(), 'a\nb\n', 'the Index is read-only');
			assert.strictEqual(index.isDirty, false);
		} finally {
			await setInline(false);
		}

		await sleep(READ_ONLY_SETTLE);
		await typeInto('workbench.action.compareEditor.focusPrimarySide', 'typed ');
		assert.ok(index.getText().includes('typed '), 'editing works again');
		await index.save();
		assert.ok(indexOf('inline.txt').includes('typed '));
	}],

	['unsaved Index edits survive inline mode and can be saved afterwards', async () => {
		commitAll('kept.txt', 'a\n');
		write('kept.txt', 'b\n');
		await openedDiff('indexEditor.openUnstagedDiff', 'kept.txt');
		await typeInto('workbench.action.compareEditor.focusPrimarySide', 'kept ');
		const index = sideEditor('git-index')!.document;
		assert.ok(index.isDirty);

		await setInline(true);
		try {
			await sleep(300);
			assert.strictEqual(await index.save().then(saved => saved, () => false), false);
			assert.strictEqual(indexOf('kept.txt'), 'a\n');
			assert.strictEqual(index.getText(), 'kept a\n');
		} finally {
			await setInline(false);
		}
		await sleep(300);
		assert.strictEqual(await index.save(), true);
		assert.strictEqual(indexOf('kept.txt'), 'kept a\n');
	}],

	['commit records exactly what the Index holds', async context => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		git('reset', '-q');
		git('checkout', '--', '.');
		git('clean', '-fdq');
		commitAll('commit.txt', 'head\n');
		write('commit.txt', 'working tree\n');
		await openedDiff('indexEditor.openUnstagedDiff', 'commit.txt');
		await typeInto('workbench.action.compareEditor.focusPrimarySide', 'indexed ');
		await sideEditor('git-index')!.document.save();
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await synced(context);

		const done = await vscode.commands.executeCommand('indexEditor.commit',
			{ message: 'only the index', amend: false, signOff: false, push: false });
		assert.strictEqual(done, true);
		assert.strictEqual(git('log', '-1', '--format=%s'), 'only the index\n');
		assert.strictEqual(headOf('commit.txt'), 'indexed head\n');
		assert.strictEqual(read('commit.txt'), 'working tree\n');
		await synced(context);
		assert.strictEqual(context.extension.staging.entries('staged').length, 0);
	}],

	['commit refuses an empty message and an empty Index', async () => {
		const before = git('rev-parse', 'HEAD');
		assert.strictEqual(await vscode.commands.executeCommand('indexEditor.commit',
			{ message: 'nothing staged', amend: false, signOff: false, push: false }), false);
		write('commit.txt', 'staged now\n');
		git('add', 'commit.txt');
		assert.strictEqual(await vscode.commands.executeCommand('indexEditor.commit',
			{ message: '   ', amend: false, signOff: false, push: false }), false);
		assert.strictEqual(git('rev-parse', 'HEAD'), before);
	}],

	['commit with author, committer and sign-off; then amend', async () => {
		const done = await vscode.commands.executeCommand('indexEditor.commit', {
			message: 'with people',
			amend: false,
			signOff: true,
			author: 'Ayşe Yazar <ayse@example.com>',
			committer: 'Test <test@example.com>',
			push: false
		});
		assert.strictEqual(done, true);
		assert.strictEqual(git('log', '-1', '--format=%an|%ae|%cn|%ce'), 'Ayşe Yazar|ayse@example.com|Test|test@example.com\n');
		assert.match(git('log', '-1', '--format=%B'), /Signed-off-by: Test <test@example.com>/);

		const count = git('rev-list', '--count', 'HEAD');
		assert.strictEqual(await vscode.commands.executeCommand('indexEditor.commit',
			{ message: 'with people, reworded', amend: true, signOff: false, push: false }), true);
		assert.strictEqual(git('rev-list', '--count', 'HEAD'), count);
		assert.strictEqual(git('log', '-1', '--format=%s'), 'with people, reworded\n');
		assert.strictEqual(git('log', '-1', '--format=%an'), 'Ayşe Yazar\n', 'amend keeps the author');
	}],

	['an invalid author stops the commit', async () => {
		write('commit.txt', 'another\n');
		git('add', 'commit.txt');
		const before = git('rev-parse', 'HEAD');
		assert.strictEqual(await vscode.commands.executeCommand('indexEditor.commit',
			{ message: 'bad author', amend: false, signOff: false, author: 'no email here', push: false }), false);
		assert.strictEqual(git('rev-parse', 'HEAD'), before);
	}],

	['Commit and Push pushes to the upstream; with nothing staged it only pushes', async context => {
		const remoteMain = () => git('rev-parse', 'origin/main').trim();
		assert.strictEqual(await vscode.commands.executeCommand('indexEditor.commit',
			{ message: 'pushed', amend: false, signOff: false, push: true }), true);
		await until('the remote branch moves', () => remoteMain() === git('rev-parse', 'HEAD').trim());

		write('commit.txt', 'committed on the command line\n');
		git('commit', '-q', '-am', 'cli commit');
		await synced(context);
		assert.strictEqual(await vscode.commands.executeCommand('indexEditor.commit',
			{ message: '', amend: false, signOff: false, push: true }), true);
		await until('the remote branch moves again', () => remoteMain() === git('rev-parse', 'HEAD').trim());
	}]
];

export async function run(): Promise<void> {
	const extension = await vscode.extensions.getExtension<ExtensionApi>('myilmaz.git-index-editor')!.activate();
	await extension.manager.ready;
	await until('the repository is found', () => extension.manager.all.length > 0, 20000);
	const context: Context = { extension, repository: extension.manager.all[0] };

	const failures: string[] = [];
	for (const [name, body] of tests) {
		try {
			await body(context);
			console.log(`  ok  ${name}`);
		} catch (error) {
			failures.push(name);
			console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.stack : error}`);
		}
		await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	}
	console.log(`${tests.length - failures.length}/${tests.length} passed`);
	if (failures.length) {
		throw new Error(`${failures.length} test(s) failed`);
	}
}
