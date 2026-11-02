import * as path from 'path';
import * as vscode from 'vscode';
import { activeDiff } from './activeDiff';
import { ensureSideBySide } from './diffMode';
import { LineSelection, takeSelection } from './lineDiff';
import { ObjectFileSystem } from './objectFileSystem';
import { Repository, RepositoryManager } from './repository';
import { INDEX_SCHEME, isEmptyUri, toEmptyUri, toFileUri, toHeadUri, toIndexUri } from './uris';

async function fileExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

async function openUnstagedDiff(file: vscode.Uri): Promise<void> {
	const index = toIndexUri(file);
	const workingTree = await fileExists(file) ? file : toEmptyUri(file);
	const layout = vscode.workspace.getConfiguration('indexEditor').get('unstagedDiffLayout');
	const name = path.basename(file.fsPath);
	if (layout === 'indexLeft') {
		await vscode.commands.executeCommand('vscode.diff', index, workingTree, `${name} (Index ↔ Working Tree)`);
	} else {
		await vscode.commands.executeCommand('vscode.diff', workingTree, index, `${name} (Working Tree ↔ Index)`);
	}
}

async function openStagedDiff(file: vscode.Uri): Promise<void> {
	const title = `${path.basename(file.fsPath)} (HEAD ↔ Index)`;
	await vscode.commands.executeCommand('vscode.diff', toHeadUri(file), toIndexUri(file), title);
}

/** Collects file URIs from whatever a menu passes: a Uri, resource states, or arrays of them. */
function resourceUris(args: readonly unknown[]): vscode.Uri[] {
	return args.flat().flatMap(arg => {
		if (arg instanceof vscode.Uri) {
			return [arg];
		}
		const resource = arg as vscode.SourceControlResourceState | undefined;
		return resource?.resourceUri ? [resource.resourceUri] : [];
	});
}

function documentSelections(editor: vscode.TextEditor): LineSelection[] {
	return editor.selections.map(selection => ({
		start: selection.start.line,
		// a selection ending at column 0 of a line does not include that line
		end: !selection.isEmpty && selection.end.character === 0 ? selection.end.line - 1 : selection.end.line,
		cursor: selection.isEmpty
	}));
}

function documentLines(document: vscode.TextDocument): string[] {
	return Array.from({ length: document.lineCount }, (_, line) => document.lineAt(line).text);
}

function eol(document: vscode.TextDocument): string {
	return document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

function replaceContent(document: vscode.TextDocument, content: string): Thenable<boolean> {
	const edit = new vscode.WorkspaceEdit();
	const whole = new vscode.Range(0, 0, document.lineCount, 0);
	edit.replace(document.uri, document.validateRange(whole), content);
	return vscode.workspace.applyEdit(edit);
}

/** Copies the change under the cursor or selection from one side of the active diff to the other. */
async function copyChange(indexFileSystem: ObjectFileSystem, from: vscode.Uri, to: vscode.Uri): Promise<void> {
	const fromDocument = await vscode.workspace.openTextDocument(from);
	const toDocument = await vscode.workspace.openTextDocument(to);
	const isSide = (editor: vscode.TextEditor) => [from.toString(), to.toString()].includes(editor.document.uri.toString());
	const active = vscode.window.activeTextEditor;
	const editor = active && isSide(active) ? active : vscode.window.visibleTextEditors.find(isSide);
	if (!editor) {
		return;
	}
	const side = editor.document.uri.toString() === from.toString() ? 'source' : 'target';
	const merged = takeSelection(documentLines(fromDocument), documentLines(toDocument), side, documentSelections(editor));
	if (!merged) {
		vscode.window.setStatusBarMessage('No change at the cursor or selection', 3000);
		return;
	}
	// an empty document has no line ending of its own, only the platform default
	const content = merged.join(eol(toDocument.getText() ? toDocument : fromDocument));
	if (to.scheme === INDEX_SCHEME && !toDocument.isDirty) {
		// Written directly rather than through a document save, so that format-on-save
		// and similar save participants cannot touch anything but the chosen lines.
		const bytes = await vscode.workspace.encode(content, { uri: to });
		await indexFileSystem.writeFile(to, bytes);
		return;
	}
	await replaceContent(toDocument, content);
	if (to.scheme === INDEX_SCHEME) {
		vscode.window.setStatusBarMessage('Index document has unsaved edits: save it to update the Index', 5000);
	}
}

async function pickRepository(manager: RepositoryManager, arg: unknown): Promise<Repository | undefined> {
	await manager.ready;
	const repositories = manager.all;
	const sourceControl = arg as vscode.SourceControl | undefined;
	if (sourceControl?.rootUri) {
		const root = sourceControl.rootUri.toString();
		return repositories.find(repository => repository.rootUri.toString() === root);
	}
	const group = arg as vscode.SourceControlResourceGroup | undefined;
	const first = group?.resourceStates?.[0]?.resourceUri;
	if (first) {
		return manager.repositoryFor(first);
	}
	const activeFile = activeDiff()?.file ?? vscode.window.activeTextEditor?.document.uri;
	const active = activeFile && repositories.find(repository => repository.relativePath(toFileUri(activeFile)) !== undefined);
	if (active || repositories.length <= 1) {
		return active ?? repositories[0];
	}
	const picked = await vscode.window.showQuickPick(
		repositories.map(repository => ({ label: path.basename(repository.git.root), description: repository.git.root, repository })),
		{ placeHolder: 'Choose a repository' }
	);
	return picked?.repository;
}

/** Groups resources by repository as paths relative to each repository's root. */
async function byRepository(manager: RepositoryManager, uris: readonly vscode.Uri[]): Promise<Map<Repository, string[]>> {
	const result = new Map<Repository, string[]>();
	for (const uri of uris) {
		const repository = await manager.repositoryFor(uri);
		const file = repository?.relativePath(uri);
		if (repository && file !== undefined) {
			result.set(repository, [...result.get(repository) ?? [], file]);
		}
	}
	return result;
}

async function discardFiles(manager: RepositoryManager, states: readonly vscode.SourceControlResourceState[]): Promise<void> {
	if (!states.length) {
		return;
	}
	const subject = states.length === 1 ? path.basename(states[0].resourceUri.fsPath) : `${states.length} files`;
	const answer = await vscode.window.showWarningMessage(
		`Discard the unstaged changes in ${subject}? Untracked files go to the trash; changes to tracked files are lost.`,
		{ modal: true },
		'Discard'
	);
	if (answer !== 'Discard') {
		return;
	}
	const isUntracked = (state: vscode.SourceControlResourceState) => state.contextValue === 'untracked';
	for (const state of states.filter(isUntracked)) {
		await vscode.workspace.fs.delete(state.resourceUri, { useTrash: true });
	}
	const tracked = states.filter(state => !isUntracked(state)).map(state => state.resourceUri);
	for (const [repository, files] of await byRepository(manager, tracked)) {
		await repository.git.restoreFromIndex(files);
	}
	await Promise.all(manager.all.map(repository => repository.refresh()));
}

async function commit(manager: RepositoryManager, arg: unknown, amend: boolean): Promise<void> {
	const repository = await pickRepository(manager, arg);
	if (!repository) {
		return;
	}
	await repository.refresh();
	const message = repository.sourceControl.inputBox.value;
	if (!message.trim() && !amend) {
		vscode.window.showWarningMessage('Enter a commit message first.');
		return;
	}
	const unsaved = vscode.workspace.textDocuments.filter(document =>
		document.uri.scheme === INDEX_SCHEME && document.isDirty && repository.relativePath(document.uri) !== undefined);
	if (unsaved.length) {
		const answer = await vscode.window.showWarningMessage(
			`${unsaved.length} Index document(s) have unsaved edits that would be left out of the commit.`,
			{ modal: true },
			'Save and Commit'
		);
		if (answer !== 'Save and Commit') {
			return;
		}
		await Promise.all(unsaved.map(document => document.save()));
		await repository.refresh();
	}
	if (!repository.staged.resourceStates.length && !amend) {
		vscode.window.showWarningMessage('There are no staged changes to commit.');
		return;
	}
	await repository.git.commit(message, amend);
	repository.sourceControl.inputBox.value = '';
	await repository.refresh();
}

export function registerCommands(manager: RepositoryManager, indexFileSystem: ObjectFileSystem, log: vscode.LogOutputChannel): vscode.Disposable {
	const register = (id: string, handler: (...args: any[]) => unknown) =>
		vscode.commands.registerCommand(id, async (...args: unknown[]) => {
			try {
				return await handler(...args);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.error(`${id}: ${message}`);
				vscode.window.showErrorMessage(message);
				return undefined;
			}
		});

	const openWith = (open: (file: vscode.Uri) => Promise<void>) => async (...args: unknown[]) => {
		const [target] = resourceUris(args);
		const current = activeDiff()?.file ?? vscode.window.activeTextEditor?.document.uri;
		const file = target ?? (current && toFileUri(current));
		if (file && await ensureSideBySide()) {
			await open(file);
		}
	};

	const withFiles = (action: (repository: Repository, files: string[]) => Promise<unknown>) => async (...args: unknown[]) => {
		const uris = resourceUris(args);
		const targets = uris.length ? uris : [activeDiff()?.file].filter(uri => uri !== undefined);
		for (const [repository, files] of await byRepository(manager, targets)) {
			await action(repository, files);
			await repository.refresh();
		}
	};

	const moveChangeToIndex = async () => {
		const diff = activeDiff();
		if (diff) {
			await copyChange(indexFileSystem, diff.other, diff.index);
		}
	};

	return vscode.Disposable.from(
		register('indexEditor.openUnstagedDiff', openWith(openUnstagedDiff)),
		register('indexEditor.openStagedDiff', openWith(openStagedDiff)),
		register('indexEditor.switchDiff', async () => {
			const diff = activeDiff();
			if (diff) {
				await (diff.kind === 'unstaged' ? openStagedDiff(diff.file) : openUnstagedDiff(diff.file));
			}
		}),
		register('indexEditor.stageChange', moveChangeToIndex),
		register('indexEditor.unstageChange', moveChangeToIndex),
		register('indexEditor.discardChange', async () => {
			const diff = activeDiff();
			if (diff?.kind === 'unstaged' && !isEmptyUri(diff.other)) {
				await copyChange(indexFileSystem, diff.index, diff.other);
			}
		}),
		register('indexEditor.stageFile', withFiles((repository, files) => repository.git.stage(files))),
		register('indexEditor.unstageFile', withFiles((repository, files) => repository.git.unstage(files))),
		register('indexEditor.discardFile', (...args: unknown[]) =>
			discardFiles(manager, args.flat() as vscode.SourceControlResourceState[])),
		register('indexEditor.openFile', async (...args: unknown[]) => {
			for (const uri of resourceUris(args)) {
				await vscode.commands.executeCommand('vscode.open', uri);
			}
		}),
		register('indexEditor.stageAll', async (arg: unknown) => {
			const repository = await pickRepository(manager, arg);
			await repository?.git.stageAll();
			await repository?.refresh();
		}),
		register('indexEditor.unstageAll', async (arg: unknown) => {
			const repository = await pickRepository(manager, arg);
			await repository?.git.unstageAll();
			await repository?.refresh();
		}),
		register('indexEditor.commit', (arg: unknown) => commit(manager, arg, false)),
		register('indexEditor.commitAmend', (arg: unknown) => commit(manager, arg, true)),
		register('indexEditor.refresh', async () => {
			await manager.ready;
			await Promise.all(manager.all.map(repository => repository.refresh()));
		})
	);
}
