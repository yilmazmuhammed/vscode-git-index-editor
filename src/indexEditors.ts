import * as path from 'path';
import * as vscode from 'vscode';
import { activeDiff, ActiveDiff } from './activeDiff';
import { ensureSideBySide } from './diffMode';
import { IndexFileSystem } from './indexFileSystem';
import { LineSelection, takeSelection } from './lineDiff';
import { Repository, RepositoryManager } from './repository';
import type { API } from './typings/git';
import { INDEX_SCHEME, isEmptyUri, toEmptyUri, toFileUri, toIndexUri } from './uris';

export type BaseMode = 'HEAD' | 'upstream';

interface Base {
	/** A ref Git can resolve. */
	readonly ref: string;
	/** How the base is named in the editor title. */
	readonly label: string;
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
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

/** Collects file URIs from whatever a menu passes: a Uri, resource states, or arrays of them. */
export function resourceUris(args: readonly unknown[]): vscode.Uri[] {
	return args.flat().flatMap(arg => {
		if (arg instanceof vscode.Uri) {
			return [arg];
		}
		const resource = arg as vscode.SourceControlResourceState | undefined;
		return resource?.resourceUri instanceof vscode.Uri ? [resource.resourceUri] : [];
	});
}

/**
 * Opens the two EGit-style Index editors. The Index is always the right side and editable; the
 * left side is what the gutter arrow copies from:
 * - Working Tree ↔ Index: the arrow stages a block.
 * - Base ↔ Index, where the base is HEAD or the upstream branch: the arrow takes a block back
 *   from the base, which unstages it when the base is HEAD.
 */
export class IndexEditors implements vscode.Disposable {
	/** Set by the title button; overrides the setting until the setting changes. */
	private baseOverride: BaseMode | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly gitApi: API,
		private readonly manager: RepositoryManager,
		private readonly indexFileSystem: IndexFileSystem
	) {
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('indexEditor.staging.stagedCompareBase')) {
				this.baseOverride = undefined;
			}
		}));
	}

	baseMode(): BaseMode {
		return this.baseOverride
			?? vscode.workspace.getConfiguration('indexEditor.staging').get<BaseMode>('stagedCompareBase', 'HEAD');
	}

	/** The ref the staged diff compares with. Without an upstream, falls back to HEAD and says so. */
	private resolveBase(repository: Repository | undefined, mode: BaseMode): Base {
		if (mode === 'upstream') {
			const upstream = repository?.api.state.HEAD?.upstream;
			if (upstream) {
				return upstream.remote === '.'
					? { ref: `refs/heads/${upstream.name}`, label: upstream.name }
					: { ref: `refs/remotes/${upstream.remote}/${upstream.name}`, label: `${upstream.remote}/${upstream.name}` };
			}
			vscode.window.showInformationMessage(vscode.l10n.t('The current branch has no upstream branch, so the Index is compared with HEAD.'));
		}
		return { ref: 'HEAD', label: 'HEAD' };
	}

	async openUnstaged(file: vscode.Uri): Promise<void> {
		if (!await ensureSideBySide()) {
			return;
		}
		const workingTree = await fileExists(file) ? file : toEmptyUri(file);
		const name = path.basename(file.fsPath);
		await vscode.commands.executeCommand('vscode.diff', workingTree, toIndexUri(file),
			vscode.l10n.t('{0} (Working Tree ↔ Index)', name));
	}

	/**
	 * @param original For a rename, the path the base has the file under.
	 * @param mode Defaults to the setting, or the last choice made with the title button.
	 */
	async openStaged(file: vscode.Uri, original?: vscode.Uri, mode = this.baseMode()): Promise<void> {
		if (!await ensureSideBySide()) {
			return;
		}
		const repository = await this.manager.repositoryFor(file);
		const base = this.resolveBase(repository, mode);
		const baseFile = original ?? file;
		const relative = repository?.relativePath(baseFile);
		// The built-in git: provider fails on a path its ref lacks, e.g. a newly added file.
		const inBase = repository && relative !== undefined && await repository.git.refEntry(base.ref, relative) !== undefined;
		const left = inBase ? this.gitApi.toGitUri(baseFile, base.ref) : toEmptyUri(baseFile, base.ref);
		const name = path.basename(file.fsPath);
		await vscode.commands.executeCommand('vscode.diff', left, toIndexUri(file),
			vscode.l10n.t('{0} ({1} ↔ Index)', name, base.label));
	}

	/** Reopens the active staged diff against the other base. */
	async toggleBase(): Promise<void> {
		const diff = activeDiff();
		if (diff?.kind !== 'staged') {
			return;
		}
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		const next: BaseMode = diff.baseRef === 'HEAD' ? 'upstream' : 'HEAD';
		this.baseOverride = next;
		const original = toFileUri(diff.other);
		await this.openStaged(diff.file, original.fsPath === diff.file.fsPath ? undefined : original, next);
		if (tab && vscode.window.tabGroups.activeTabGroup.activeTab !== tab) {
			await vscode.window.tabGroups.close(tab, true);
		}
	}

	/** Copies the change under the cursor or selection from one side of the active diff to the other. */
	async copyChange(from: vscode.Uri, to: vscode.Uri): Promise<void> {
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
			vscode.window.setStatusBarMessage(vscode.l10n.t('No change at the cursor or selection'), 3000);
			return;
		}
		// an empty document has no line ending of its own, only the platform default
		const content = merged.join(eol(toDocument.getText() ? toDocument : fromDocument));
		if (to.scheme === INDEX_SCHEME && !toDocument.isDirty) {
			// Written directly rather than through a document save, so that format-on-save
			// and similar save participants cannot touch anything but the chosen lines.
			const bytes = await vscode.workspace.encode(content, { uri: to });
			await this.indexFileSystem.writeFile(to, bytes);
			return;
		}
		await replaceContent(toDocument, content);
		if (to.scheme === INDEX_SCHEME) {
			vscode.window.setStatusBarMessage(vscode.l10n.t('The Index document has unsaved edits: save it to update the Index'), 5000);
		}
	}

	/** Asks before throwing away unsaved edits of the active diff's Index document. False if the user declines. */
	private async confirmDiscardEdits(diff: ActiveDiff): Promise<boolean> {
		const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === diff.index.toString());
		if (!document?.isDirty) {
			return true;
		}
		const discard = vscode.l10n.t('Discard Edits');
		const answer = await vscode.window.showWarningMessage(
			vscode.l10n.t('The Index document has unsaved edits. Discard them?'), { modal: true }, discard);
		if (answer !== discard) {
			return false;
		}
		await vscode.commands.executeCommand('workbench.action.compareEditor.focusPrimarySide');
		await vscode.commands.executeCommand('workbench.action.files.revert');
		return true;
	}

	/** Stages the whole file of the active Working Tree ↔ Index diff. */
	async stageWholeFile(): Promise<void> {
		const diff = activeDiff();
		const repository = diff && await this.manager.repositoryFor(diff.file);
		const file = repository?.relativePath(diff!.file);
		if (!diff || !repository || file === undefined || !await this.confirmDiscardEdits(diff)) {
			return;
		}
		await repository.git.stage([file]);
		await repository.refresh();
	}

	/** Makes the Index of the active Base ↔ Index diff equal to the base. */
	async resetIndexToBase(): Promise<void> {
		const diff = activeDiff();
		const repository = diff && await this.manager.repositoryFor(diff.file);
		const file = repository?.relativePath(diff!.file);
		if (!diff || diff.kind !== 'staged' || !repository || file === undefined || !await this.confirmDiscardEdits(diff)) {
			return;
		}
		await repository.git.resetIndexTo(diff.baseRef ?? 'HEAD', file);
		await repository.refresh();
	}

	/** Drops unsaved edits of the active Index document and shows what the Index holds now. */
	async reloadIndex(): Promise<void> {
		const diff = activeDiff();
		if (!diff || !await this.confirmDiscardEdits(diff)) {
			return;
		}
		const repository = await this.manager.repositoryFor(diff.file);
		if (repository) {
			await this.indexFileSystem.refresh(repository);
		}
	}

	register(run: (id: string, handler: (...args: any[]) => unknown) => vscode.Disposable): vscode.Disposable {
		const openWith = (open: (file: vscode.Uri) => Promise<void>) => async (...args: unknown[]) => {
			const [target] = resourceUris(args);
			const current = activeDiff()?.file ?? vscode.window.activeTextEditor?.document.uri;
			const file = target ?? (current && toFileUri(current));
			if (file) {
				await open(file);
			}
		};
		const moveChangeToIndex = async () => {
			const diff = activeDiff();
			if (diff) {
				await this.copyChange(diff.other, diff.index);
			}
		};
		return vscode.Disposable.from(
			run('indexEditor.openUnstagedDiff', openWith(file => this.openUnstaged(file))),
			run('indexEditor.openStagedDiff', openWith(file => this.openStaged(file))),
			run('indexEditor.switchDiff', async () => {
				const diff = activeDiff();
				if (diff) {
					await (diff.kind === 'unstaged' ? this.openStaged(diff.file) : this.openUnstaged(diff.file));
				}
			}),
			run('indexEditor.toggleStagedBase', () => this.toggleBase()),
			run('indexEditor.stageChange', moveChangeToIndex),
			run('indexEditor.unstageChange', moveChangeToIndex),
			run('indexEditor.discardChange', async () => {
				const diff = activeDiff();
				if (diff?.kind === 'unstaged' && !isEmptyUri(diff.other)) {
					await this.copyChange(diff.index, diff.other);
				}
			}),
			run('indexEditor.stageWholeFile', () => this.stageWholeFile()),
			run('indexEditor.resetIndexToBase', () => this.resetIndexToBase()),
			run('indexEditor.reloadIndex', () => this.reloadIndex())
		);
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}
}
