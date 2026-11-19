import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { IndexEditors, resourceUris } from '../indexEditors';
import { Repository, RepositoryManager } from '../repository';
import type { API } from '../typings/git';
import { Entry, entriesOf, ListKind, Node, pathsOf, Presentation, SortOrder } from './entries';
import { StagingActions, StagingController } from './stagingView';

type Register = (id: string, handler: (...args: any[]) => unknown) => vscode.Disposable;

/** Stages and unstages entries; also used by drag and drop. */
export const stagingActions: StagingActions = {
	async stage(repository, entries) {
		await repository.git.stage(pathsOf(entries));
		await repository.refresh();
	},
	async unstage(repository, entries) {
		await repository.git.unstage(pathsOf(entries));
		await repository.refresh();
	}
};

async function confirm(message: string, action: string): Promise<boolean> {
	return await vscode.window.showWarningMessage(message, { modal: true }, action) === action;
}

function subject(entries: readonly Entry[]): string {
	return entries.length === 1 ? path.posix.basename(entries[0].path) : vscode.l10n.t('{0} files', entries.length);
}

/** Appends a pattern to a `.gitignore` file, starting it on a line of its own. */
async function appendIgnore(file: string, pattern: string): Promise<void> {
	let existing = '';
	try {
		existing = await fs.readFile(file, 'utf8');
	} catch {
		// a new .gitignore
	}
	const lines = existing.split(/\r?\n/);
	if (lines.includes(pattern)) {
		return;
	}
	const newline = existing.includes('\r\n') ? '\r\n' : '\n';
	const separator = existing && !existing.endsWith('\n') ? newline : '';
	await fs.writeFile(file, `${existing}${separator}${pattern}${newline}`);
}

/** Paths are relative to the repository; ignore patterns are relative to the .gitignore's folder, as EGit writes them. */
async function ignore(repository: Repository, relative: string, folder: boolean): Promise<void> {
	const parent = path.posix.dirname(relative);
	const name = path.posix.basename(relative);
	const gitignore = path.join(repository.git.root, parent === '.' ? '' : parent, '.gitignore');
	await appendIgnore(gitignore, `/${name}${folder ? '/' : ''}`);
}

export function registerStagingCommands(
	register: Register,
	gitApi: API,
	manager: RepositoryManager,
	controller: StagingController,
	editors: IndexEditors
): vscode.Disposable {
	/** Entries for files given as URIs or resource states, grouped by repository. */
	const entriesForUris = async (list: ListKind, uris: readonly vscode.Uri[]): Promise<Map<Repository, Entry[]>> => {
		const groups = new Map<Repository, Entry[]>();
		for (const uri of uris) {
			const repository = await manager.repositoryFor(uri);
			const file = repository?.relativePath(uri);
			if (!repository || file === undefined) {
				continue;
			}
			const known = controller.allEntries(repository, list).find(entry => entry.path === file);
			groups.set(repository, [...groups.get(repository) ?? [], known ?? { list, path: file, kind: 'modified', partial: false }]);
		}
		return groups;
	};

	/**
	 * Runs an action on the entries a command was invoked on: Staging view nodes, in the view's
	 * repository, or files given as URIs or resource states, as callers of version 0.1.0 passed them.
	 */
	const on = (list: ListKind, action: (repository: Repository, entries: Entry[]) => Promise<unknown>) =>
		async (...args: unknown[]) => {
			const uris = resourceUris(args);
			const groups = uris.length
				? await entriesForUris(list, uris)
				: new Map(controller.repository ? [[controller.repository, controller.entriesFromArgs(list, args)]] : []);
			for (const [repository, entries] of groups) {
				if (entries.length) {
					await action(repository, entries);
					await repository.refresh();
				}
			}
		};

	const fileUri = (repository: Repository, entry: Entry) => repository.fileUri(entry.path);
	const tracked = (entries: readonly Entry[]) => entries.filter(entry => entry.kind !== 'untracked');

	const open = async (node: Node | undefined) => {
		const repository = controller.repository;
		const entry = node && entriesOf(node)[0];
		if (!repository || !entry || node?.type !== 'file') {
			return;
		}
		const file = fileUri(repository, entry);
		if (entry.kind === 'conflict') {
			try {
				await vscode.commands.executeCommand('git.openMergeEditor', file);
			} catch {
				await vscode.commands.executeCommand('vscode.open', file);
			}
			return;
		}
		const stat = await fs.stat(file.fsPath).catch(() => undefined);
		if (stat?.isDirectory()) {
			vscode.window.showInformationMessage(vscode.l10n.t('{0} is a submodule; open it as a repository to stage its changes.', entry.path));
			return;
		}
		if (entry.list === 'unstaged') {
			await editors.openUnstaged(file);
		} else {
			await editors.openStaged(file, entry.originalPath ? repository.fileUri(entry.originalPath) : undefined);
		}
	};

	const both = (id: string, action: (repository: Repository, entries: Entry[]) => Promise<unknown>) => [
		register(`indexEditor.staging.${id}`, on('unstaged', action)),
		register(`indexEditor.staging.staged.${id}`, on('staged', action))
	];

	const replaceWithHead = async (repository: Repository, entries: Entry[]) => {
		const files = tracked(entries);
		if (files.length && await confirm(
			vscode.l10n.t('Replace {0} with the HEAD revision? The changes in the Index and in the working tree are lost.', subject(files)),
			vscode.l10n.t('Replace'))) {
			await repository.git.restoreFromSource('HEAD', pathsOf(files));
		}
	};

	const copyPaths = async (repository: Repository, entries: Entry[], relative: boolean) => {
		const paths = entries.map(entry => relative ? entry.path : fileUri(repository, entry).fsPath);
		await vscode.env.clipboard.writeText(paths.join('\n'));
	};

	return vscode.Disposable.from(
		register('indexEditor.staging.open', open),
		register('indexEditor.stageFile', on('unstaged', (repository, entries) => stagingActions.stage(repository, entries))),
		register('indexEditor.unstageFile', on('staged', (repository, entries) => stagingActions.unstage(repository, entries))),
		register('indexEditor.stageAll', async () => {
			const repository = controller.repository;
			await repository?.git.stageAll();
			await repository?.refresh();
		}),
		register('indexEditor.unstageAll', async () => {
			const repository = controller.repository;
			await repository?.git.unstageAll();
			await repository?.refresh();
		}),
		register('indexEditor.refresh', async () => {
			await controller.repository?.refresh();
			controller.update();
		}),
		register('indexEditor.staging.filter', async () => {
			const filter = await vscode.window.showInputBox({
				title: vscode.l10n.t('Filter Files'),
				prompt: vscode.l10n.t('Part of a path; * matches any text and ? one character.'),
				value: controller.filter
			});
			if (filter !== undefined) {
				controller.setFilter(filter);
			}
		}),
		register('indexEditor.staging.clearFilter', () => controller.setFilter('')),
		register('indexEditor.staging.presentation', async () => {
			const current = vscode.workspace.getConfiguration('indexEditor.staging').get<Presentation>('presentation', 'list');
			const items: (vscode.QuickPickItem & { value: Presentation })[] = [
				{ label: vscode.l10n.t('List'), value: 'list' },
				{ label: vscode.l10n.t('Tree'), value: 'tree' },
				{ label: vscode.l10n.t('Compact Tree'), value: 'compactTree' }
			];
			for (const item of items) {
				item.description = item.value === current ? vscode.l10n.t('current') : undefined;
			}
			const picked = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Presentation') });
			if (picked) {
				await vscode.workspace.getConfiguration('indexEditor.staging').update('presentation', picked.value, vscode.ConfigurationTarget.Global);
			}
		}),
		register('indexEditor.staging.sort', async () => {
			const current = vscode.workspace.getConfiguration('indexEditor.staging').get<SortOrder>('sortBy', 'name');
			const items: (vscode.QuickPickItem & { value: SortOrder })[] = [
				{ label: vscode.l10n.t('By Name'), value: 'name' },
				{ label: vscode.l10n.t('By Status'), value: 'status' }
			];
			for (const item of items) {
				item.description = item.value === current ? vscode.l10n.t('current') : undefined;
			}
			const picked = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Sort Files') });
			if (picked) {
				await vscode.workspace.getConfiguration('indexEditor.staging').update('sortBy', picked.value, vscode.ConfigurationTarget.Global);
			}
		}),
		register('indexEditor.staging.showUntracked', () =>
			vscode.workspace.getConfiguration('indexEditor.staging').update('showUntracked', true, vscode.ConfigurationTarget.Global)),
		register('indexEditor.staging.hideUntracked', () =>
			vscode.workspace.getConfiguration('indexEditor.staging').update('showUntracked', false, vscode.ConfigurationTarget.Global)),
		register('indexEditor.staging.selectRepository', async () => {
			await manager.ready;
			const picked = await vscode.window.showQuickPick(
				manager.all.map(repository => ({
					label: repository.name,
					description: repository.git.root,
					picked: repository === controller.repository,
					repository
				})),
				{ title: vscode.l10n.t('Select Repository') }
			);
			if (picked) {
				controller.selectRepository(picked.repository);
			}
		}),
		register('indexEditor.openFile', on('unstaged', async (repository, entries) => {
			for (const entry of entries.filter(entry => entry.kind !== 'deleted')) {
				await vscode.commands.executeCommand('vscode.open', fileUri(repository, entry));
			}
		})),
		...both('compareWithHead', async (repository, entries) => {
			for (const entry of entries) {
				const file = fileUri(repository, entry);
				const head = gitApi.toGitUri(entry.originalPath ? repository.fileUri(entry.originalPath) : file, 'HEAD');
				await vscode.commands.executeCommand('vscode.diff', head, file,
					vscode.l10n.t('{0} (HEAD ↔ Working Tree)', path.posix.basename(entry.path)));
			}
		}),
		...both('compareEachOther', async (repository, entries) => {
			if (entries.length !== 2) {
				vscode.window.showInformationMessage(vscode.l10n.t('Select exactly two files to compare.'));
				return;
			}
			const [left, right] = entries.map(entry => fileUri(repository, entry));
			await vscode.commands.executeCommand('vscode.diff', left, right,
				`${path.posix.basename(entries[0].path)} ↔ ${path.posix.basename(entries[1].path)}`);
		}),
		register('indexEditor.discardFile', on('unstaged', async (repository, entries) => {
			if (!await confirm(
				vscode.l10n.t('Discard the unstaged changes in {0}? Untracked files go to the trash; changes to tracked files are lost.', subject(entries)),
				vscode.l10n.t('Discard'))) {
				return;
			}
			for (const entry of entries.filter(entry => entry.kind === 'untracked')) {
				await vscode.workspace.fs.delete(fileUri(repository, entry), { useTrash: true });
			}
			const files = tracked(entries).filter(entry => entry.kind !== 'conflict');
			if (files.length) {
				await repository.git.restoreFromIndex(pathsOf(files));
			}
		})),
		...both('replaceWithHead', replaceWithHead),
		register('indexEditor.staging.replaceWithOurs', on('unstaged', (repository, entries) =>
			repository.git.takeConflictSide('ours', entries.filter(entry => entry.kind === 'conflict').map(entry => entry.path)))),
		register('indexEditor.staging.replaceWithTheirs', on('unstaged', (repository, entries) =>
			repository.git.takeConflictSide('theirs', entries.filter(entry => entry.kind === 'conflict').map(entry => entry.path)))),
		register('indexEditor.staging.mergeTool', on('unstaged', async (repository, entries) => {
			for (const entry of entries.filter(entry => entry.kind === 'conflict')) {
				await vscode.commands.executeCommand('git.openMergeEditor', fileUri(repository, entry));
			}
		})),
		register('indexEditor.staging.ignore', on('unstaged', async (repository, entries) => {
			for (const entry of entries) {
				await ignore(repository, entry.path, false);
			}
		})),
		register('indexEditor.staging.ignoreFolder', on('unstaged', async (repository, entries) => {
			const folders = new Set(entries.map(entry => path.posix.dirname(entry.path)).filter(folder => folder !== '.'));
			if (!folders.size) {
				vscode.window.showInformationMessage(vscode.l10n.t('Files in the repository root have no folder to ignore.'));
			}
			for (const folder of folders) {
				await ignore(repository, folder, true);
			}
		})),
		register('indexEditor.staging.delete', on('unstaged', async (repository, entries) => {
			const files = entries.filter(entry => entry.kind !== 'deleted');
			if (files.length && await confirm(
				vscode.l10n.t('Delete {0} from the working tree? The files go to the trash.', subject(files)),
				vscode.l10n.t('Delete'))) {
				for (const entry of files) {
					await vscode.workspace.fs.delete(fileUri(repository, entry), { useTrash: true, recursive: true });
				}
			}
		})),
		register('indexEditor.staging.assumeUnchanged', on('unstaged', async (repository, entries) => {
			const files = tracked(entries).filter(entry => entry.kind !== 'conflict' && entry.kind !== 'added');
			if (files.length) {
				await repository.git.setAssumeUnchanged(files.map(entry => entry.path), true);
			}
		})),
		register('indexEditor.staging.noAssumeUnchanged', async () => {
			const repository = controller.repository;
			if (!repository) {
				return;
			}
			const files = await repository.git.assumeUnchangedFiles();
			if (!files.length) {
				vscode.window.showInformationMessage(vscode.l10n.t('No file is marked assume-unchanged.'));
				return;
			}
			const picked = await vscode.window.showQuickPick(files.map(file => ({ label: file })), {
				title: vscode.l10n.t('No Assume Unchanged'),
				placeHolder: vscode.l10n.t('Files whose changes Git should see again'),
				canPickMany: true
			});
			if (picked?.length) {
				await repository.git.setAssumeUnchanged(picked.map(item => item.label), false);
				await repository.refresh();
			}
		}),
		...both('untrack', async (repository, entries) => {
			const files = tracked(entries).filter(entry => entry.kind !== 'deleted');
			if (files.length) {
				await repository.git.untrack(files.map(entry => entry.path));
			}
		}),
		...both('copyPath', (repository, entries) => copyPaths(repository, entries, false)),
		...both('copyRelativePath', (repository, entries) => copyPaths(repository, entries, true)),
		...both('revealInExplorer', async (repository, entries) => {
			const entry = entries.find(candidate => candidate.kind !== 'deleted');
			if (entry) {
				await vscode.commands.executeCommand('revealInExplorer', fileUri(repository, entry));
			}
		})
	);
}
