import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Repository, RepositoryManager } from '../../src/repository';

const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
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

const tests: [string, (repository: Repository) => Promise<void>][] = [
	['SCM groups separate unstaged and staged changes of the same file', async repository => {
		commitAll('groups.txt', 'one\n');
		write('groups.txt', 'one\ntwo\n');
		git('add', 'groups.txt');
		write('groups.txt', 'one\ntwo\nthree\n');
		write('untracked.txt', 'new\n');
		await repository.refresh();
		const names = (group: vscode.SourceControlResourceGroup) =>
			group.resourceStates.map(state => path.basename(state.resourceUri.fsPath)).sort();
		assert.deepStrictEqual(names(repository.unstaged), ['groups.txt', 'untracked.txt']);
		assert.deepStrictEqual(names(repository.staged), ['groups.txt']);
		git('reset', '-q', 'groups.txt');
		git('checkout', '--', 'groups.txt');
		fs.unlinkSync(path.join(root, 'untracked.txt'));
	}],

	['saving the Index side of the unstaged diff updates only the Index', async () => {
		commitAll('save.txt', 'head\n');
		write('save.txt', 'working tree\n');
		await openedDiff('indexEditor.openUnstagedDiff', 'save.txt');
		const input = vscode.window.tabGroups.activeTabGroup.activeTab!.input as vscode.TabInputTextDiff;
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

	['the staged diff edits the Index and keeps HEAD read-only', async () => {
		await openedDiff('indexEditor.openStagedDiff', 'save.txt');
		const input = vscode.window.tabGroups.activeTabGroup.activeTab!.input as vscode.TabInputTextDiff;
		assert.strictEqual(input.original.scheme, 'git-head');
		assert.strictEqual(input.modified.scheme, 'git-index');

		await typeInto('workbench.action.compareEditor.focusSecondarySide', 'nope ');
		assert.strictEqual(sideEditor('git-head')!.document.getText(), 'head\n');
		assert.strictEqual(sideEditor('git-head')!.document.isDirty, false);

		await typeInto('workbench.action.compareEditor.focusPrimarySide', 'more ');
		const index = sideEditor('git-index')!.document;
		assert.strictEqual(index.getText(), 'more typed head\n');
		await index.save();
		assert.strictEqual(indexOf('save.txt'), 'more typed head\n');
		assert.strictEqual(read('save.txt'), 'left working tree\n');
	}],

	['the indexLeft layout keeps the Index editable on the original side', async () => {
		const config = vscode.workspace.getConfiguration('indexEditor');
		await config.update('unstagedDiffLayout', 'indexLeft', vscode.ConfigurationTarget.Global);
		try {
			await openedDiff('indexEditor.openUnstagedDiff', 'save.txt');
			const input = vscode.window.tabGroups.activeTabGroup.activeTab!.input as vscode.TabInputTextDiff;
			assert.strictEqual(input.original.scheme, 'git-index');
			await typeInto('workbench.action.compareEditor.focusSecondarySide', 'L ');
			const index = sideEditor('git-index')!.document;
			assert.strictEqual(index.getText(), 'L more typed head\n');
			await index.save();
			assert.strictEqual(indexOf('save.txt'), 'L more typed head\n');
		} finally {
			await config.update('unstagedDiffLayout', undefined, vscode.ConfigurationTarget.Global);
		}
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
		git('config', 'core.autocrlf', 'true');
		try {
			write('crlf.txt', 'a\r\nb\r\nc\r\nd\r\nE\r\n');
			await openedDiff('indexEditor.openUnstagedDiff', 'crlf.txt');
			await vscode.commands.executeCommand('workbench.action.compareEditor.focusSecondarySide');
			select(sideEditor('file')!, 4);
			await vscode.commands.executeCommand('indexEditor.stageChange');
			assert.strictEqual(indexOf('crlf.txt'), 'a\nb\nc\nd\nE\n');
		} finally {
			git('config', 'core.autocrlf', 'false');
		}
	}],

	['an open Index document follows changes made outside the editor', async repository => {
		commitAll('outside.txt', 'old\n');
		write('outside.txt', 'new\n');
		await openedDiff('indexEditor.openUnstagedDiff', 'outside.txt');
		const index = sideEditor('git-index')!.document;
		assert.strictEqual(index.getText(), 'old\n');
		git('add', 'outside.txt');
		await until('the Index document reloads', () => index.getText() === 'new\n');
		await until('the file leaves the unstaged group', () =>
			!repository.unstaged.resourceStates.some(state => state.resourceUri.fsPath.endsWith('outside.txt')));
	}],

	['a file deleted from the working tree can be compared with the Index', async () => {
		commitAll('deleted.txt', 'still here\n');
		fs.unlinkSync(path.join(root, 'deleted.txt'));
		await openedDiff('indexEditor.openUnstagedDiff', 'deleted.txt');
		assert.strictEqual(sideEditor('git-index')!.document.getText(), 'still here\n');
		assert.strictEqual(sideEditor('git-head')!.document.getText(), '');
		git('checkout', '--', 'deleted.txt');
	}],

	['switchDiff moves between the two diffs of a file', async () => {
		await openedDiff('indexEditor.openUnstagedDiff', 'save.txt');
		await vscode.commands.executeCommand('indexEditor.switchDiff');
		await until('the staged diff is active', () => {
			const input = vscode.window.tabGroups.activeTabGroup.activeTab!.input as vscode.TabInputTextDiff;
			return input.original.scheme === 'git-head';
		});
		await vscode.commands.executeCommand('indexEditor.switchDiff');
		await until('the unstaged diff is active', () => {
			const input = vscode.window.tabGroups.activeTabGroup.activeTab!.input as vscode.TabInputTextDiff;
			return input.original.scheme === 'file';
		});
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

	['file commands stage and unstage from SCM resource states', async repository => {
		commitAll('scm.txt', 'a\n');
		write('scm.txt', 'b\n');
		await repository.refresh();
		const state = () => repository.unstaged.resourceStates.find(s => s.resourceUri.fsPath.endsWith('scm.txt'));
		await vscode.commands.executeCommand('indexEditor.stageFile', state());
		assert.strictEqual(indexOf('scm.txt'), 'b\n');
		const staged = repository.staged.resourceStates.find(s => s.resourceUri.fsPath.endsWith('scm.txt'));
		await vscode.commands.executeCommand('indexEditor.unstageFile', staged);
		assert.strictEqual(indexOf('scm.txt'), 'a\n');
		assert.ok(state());
	}],

	['commit records exactly what the Index holds', async repository => {
		commitAll('commit.txt', 'head\n');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		git('reset', '-q');
		git('checkout', '--', '.');
		git('clean', '-fdq');
		write('commit.txt', 'working tree\n');
		await openedDiff('indexEditor.openUnstagedDiff', 'commit.txt');
		await typeInto('workbench.action.compareEditor.focusPrimarySide', 'indexed ');
		await sideEditor('git-index')!.document.save();

		repository.sourceControl.inputBox.value = 'only the index';
		await vscode.commands.executeCommand('indexEditor.commit', repository.sourceControl);
		assert.strictEqual(git('log', '-1', '--format=%s'), 'only the index\n');
		assert.strictEqual(headOf('commit.txt'), 'indexed head\n');
		assert.strictEqual(read('commit.txt'), 'working tree\n');
		assert.strictEqual(repository.sourceControl.inputBox.value, '');
		assert.strictEqual(repository.staged.resourceStates.length, 0);
	}]
];

export async function run(): Promise<void> {
	const extension = vscode.extensions.getExtension<{ manager: RepositoryManager }>('myilmaz.git-index-editor')!;
	const { manager } = await extension.activate();
	await manager.ready;
	const repository = manager.all[0];
	assert.ok(repository, 'the repository is found');

	const failures: string[] = [];
	for (const [name, body] of tests) {
		try {
			await body(repository);
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
