import * as vscode from 'vscode';
import { trackActiveDiff } from './activeDiff';
import { saveBlockMoves } from './blockSave';
import { AssumeUnchangedDecorations } from './assumeUnchangedDecorations';
import { onDidChangeDiffMode } from './diffMode';
import { EmptyFileSystem, IndexFileSystem } from './indexFileSystem';
import { IndexEditors } from './indexEditors';
import { BranchService } from './repositories/branchService';
import { RemoteEditors } from './repositories/remoteEditor';
import { RemoteService } from './repositories/remoteService';
import { registerRepositoriesCommands } from './repositories/repositoriesCommands';
import { RepositoriesView } from './repositories/repositoriesView';
import { RepositoryManager } from './repository';
import { CommitRequest, CommitService } from './staging/commitService';
import { CommitViewProvider } from './staging/commitView';
import { registerStagingCommands, stagingActions } from './staging/stagingCommands';
import { StagingController } from './staging/stagingView';
import type { API, GitExtension } from './typings/git';
import { EMPTY_SCHEME, INDEX_SCHEME } from './uris';

/** What the extension exposes, for its integration tests. */
export interface ExtensionApi {
	readonly manager: RepositoryManager;
	readonly staging: StagingController;
	readonly editors: IndexEditors;
	readonly repositories: RepositoriesView;
	readonly branches: BranchService;
	readonly remotes: RemoteService;
}

function isCommitRequest(value: unknown): value is CommitRequest {
	return typeof value === 'object' && value !== null && typeof (value as CommitRequest).message === 'string';
}

async function gitApi(log: vscode.LogOutputChannel): Promise<API | undefined> {
	const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!extension) {
		log.error('The built-in Git extension is missing.');
		return undefined;
	}
	const git = extension.isActive ? extension.exports : await extension.activate();
	if (!git.enabled) {
		log.warn('Git is disabled (git.enabled is false), so Git Index Editor stays off. Reload the window after enabling it.');
		return undefined;
	}
	return git.getAPI(1);
}

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi | undefined> {
	const log = vscode.window.createOutputChannel('Git Index Editor', { log: true });
	context.subscriptions.push(log);
	const api = await gitApi(log);
	if (!api) {
		return undefined;
	}

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

	const manager = new RepositoryManager(api, log);
	const isCaseSensitive = process.platform === 'linux';
	const indexFileSystem = new IndexFileSystem(manager);
	const editors = new IndexEditors(api, manager, indexFileSystem);
	const staging = new StagingController(manager, stagingActions);
	const commits = new CommitService(context.globalState, log);
	const commitView = new CommitViewProvider(context, manager, staging, commits, log);
	const repositories = new RepositoriesView(manager);
	const branches = new BranchService(log);
	const remotes = new RemoteService(branches, log);
	const remoteEditors = new RemoteEditors(context, remotes, repository => repositories.refresh(repository));

	context.subscriptions.push(
		manager,
		editors,
		staging,
		commitView,
		repositories,
		remoteEditors,
		registerRepositoriesCommands(register, manager, repositories, branches, remotes, remoteEditors, commits, staging),
		new AssumeUnchangedDecorations(manager, log),
		vscode.workspace.registerFileSystemProvider(INDEX_SCHEME, indexFileSystem, { isCaseSensitive }),
		vscode.workspace.registerFileSystemProvider(EMPTY_SCHEME, new EmptyFileSystem(), { isCaseSensitive, isReadonly: true }),
		vscode.window.registerWebviewViewProvider(CommitViewProvider.viewId, commitView),
		manager.onDidChange(repository => {
			indexFileSystem.refresh(repository).catch(error => log.error(error));
		}),
		onDidChangeDiffMode(() => indexFileSystem.reloadOpenDocuments()),
		trackActiveDiff(),
		saveBlockMoves(error => log.error(error instanceof Error ? error : String(error))),
		editors.register(register),
		registerStagingCommands(register, api, manager, staging, editors),
		// With a request (tests, other extensions) commits it; from a key or the palette, commits
		// what the commit area holds, as the 0.1.0 commands committed the Source Control message.
		register('indexEditor.commit', (request?: CommitRequest) =>
			isCommitRequest(request) ? commitView.commitFromCommand(request) : commitView.submit(false)),
		register('indexEditor.commitAmend', () => commitView.submit(true)),
		register('indexEditor.focusCommit', () => vscode.commands.executeCommand(`${CommitViewProvider.viewId}.focus`))
	);
	return { manager, staging, editors, repositories, branches, remotes };
}

export function deactivate(): void { }
