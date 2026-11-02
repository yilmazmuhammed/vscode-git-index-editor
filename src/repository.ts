import * as path from 'path';
import * as vscode from 'vscode';
import { ChangeKind, GitRepository, StatusEntry } from './git';

const REFRESH_DELAY = 150;

const CHANGE_STYLES: Record<ChangeKind, { icon: string; color: string; label: string }> = {
	modified: { icon: 'diff-modified', color: 'gitDecoration.modifiedResourceForeground', label: 'Modified' },
	added: { icon: 'diff-added', color: 'gitDecoration.addedResourceForeground', label: 'Added' },
	deleted: { icon: 'diff-removed', color: 'gitDecoration.deletedResourceForeground', label: 'Deleted' },
	typeChanged: { icon: 'diff-modified', color: 'gitDecoration.modifiedResourceForeground', label: 'Type changed' },
	untracked: { icon: 'diff-added', color: 'gitDecoration.untrackedResourceForeground', label: 'Untracked' }
};

export function gitBinary(): string {
	const configured = vscode.workspace.getConfiguration('git').get<string | string[] | null>('path');
	return (Array.isArray(configured) ? configured[0] : configured) || 'git';
}

export class Repository implements vscode.Disposable {
	readonly rootUri: vscode.Uri;
	readonly sourceControl: vscode.SourceControl;
	readonly conflicts: vscode.SourceControlResourceGroup;
	readonly unstaged: vscode.SourceControlResourceGroup;
	readonly staged: vscode.SourceControlResourceGroup;

	private readonly didChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this.didChange.event;

	private readonly disposables: vscode.Disposable[] = [this.didChange];
	private refreshTimer: NodeJS.Timeout | undefined;
	private refreshing: Promise<void> | undefined;
	private refreshAgain = false;

	constructor(readonly git: GitRepository, private readonly log: vscode.LogOutputChannel) {
		this.rootUri = vscode.Uri.file(git.root);

		const sourceControl = vscode.scm.createSourceControl('indexEditor', 'Git Index', this.rootUri);
		sourceControl.acceptInputCommand = { command: 'indexEditor.commit', title: 'Commit', arguments: [sourceControl] };
		sourceControl.inputBox.placeholder = 'Message (Ctrl+Enter to commit staged changes)';
		this.sourceControl = sourceControl;

		this.conflicts = sourceControl.createResourceGroup('conflicts', 'Merge Conflicts');
		this.conflicts.hideWhenEmpty = true;
		this.unstaged = sourceControl.createResourceGroup('unstaged', 'Unstaged Changes');
		this.staged = sourceControl.createResourceGroup('staged', 'Staged Changes');
		this.disposables.push(this.conflicts, this.unstaged, this.staged, sourceControl);

		const schedule = () => this.scheduleRefresh();
		const onTreeChange = (uri: vscode.Uri) => {
			if (!/\/\.git(\/|$)/.test(uri.path)) {
				schedule();
			}
		};
		const tree = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.rootUri, '**'));
		const meta = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(git.gitDir), '{index,HEAD,ORIG_HEAD,MERGE_HEAD,refs/**}')
		);
		this.disposables.push(
			tree, meta,
			tree.onDidCreate(onTreeChange), tree.onDidChange(onTreeChange), tree.onDidDelete(onTreeChange),
			meta.onDidCreate(schedule), meta.onDidChange(schedule), meta.onDidDelete(schedule),
			vscode.workspace.onDidSaveTextDocument(schedule),
			vscode.window.onDidChangeWindowState(state => {
				if (state.focused) {
					schedule();
				}
			})
		);
	}

	/** The path of a document inside this repository, or undefined if it lies outside. */
	relativePath(uri: vscode.Uri): string | undefined {
		const relative = path.relative(this.git.root, uri.fsPath);
		if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
			return undefined;
		}
		return relative.split(path.sep).join('/');
	}

	scheduleRefresh(): void {
		clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => {
			this.refresh().catch(error => this.log.error(error));
		}, REFRESH_DELAY);
	}

	refresh(): Promise<void> {
		if (this.refreshing) {
			this.refreshAgain = true;
			return this.refreshing;
		}
		const run = async () => {
			do {
				this.refreshAgain = false;
				this.apply(await this.git.status());
			} while (this.refreshAgain);
		};
		this.refreshing = run().finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}

	private apply(entries: readonly StatusEntry[]): void {
		const unstagedCommand = 'indexEditor.openUnstagedDiff';
		const stagedCommand = 'indexEditor.openStagedDiff';
		this.conflicts.resourceStates = entries.filter(entry => entry.conflicted)
			.map(entry => this.conflictResource(entry));
		this.unstaged.resourceStates = entries.filter(entry => entry.unstaged)
			.map(entry => this.resource(entry, entry.unstaged!, unstagedCommand));
		this.staged.resourceStates = entries.filter(entry => entry.staged)
			.map(entry => this.resource(entry, entry.staged!, stagedCommand));
		this.sourceControl.count = entries.length;
		this.didChange.fire();
	}

	private fileUri(entry: StatusEntry): vscode.Uri {
		return vscode.Uri.file(path.join(this.git.root, entry.path));
	}

	private resource(entry: StatusEntry, kind: ChangeKind, commandId: string): vscode.SourceControlResourceState {
		const uri = this.fileUri(entry);
		const style = CHANGE_STYLES[kind];
		return {
			resourceUri: uri,
			command: entry.submodule ? undefined : { command: commandId, title: 'Open Diff', arguments: [uri] },
			contextValue: kind,
			decorations: {
				iconPath: new vscode.ThemeIcon(style.icon, new vscode.ThemeColor(style.color)),
				strikeThrough: kind === 'deleted',
				tooltip: style.label
			}
		};
	}

	private conflictResource(entry: StatusEntry): vscode.SourceControlResourceState {
		const uri = this.fileUri(entry);
		return {
			resourceUri: uri,
			command: { command: 'vscode.open', title: 'Open File', arguments: [uri] },
			decorations: {
				iconPath: new vscode.ThemeIcon('warning', new vscode.ThemeColor('gitDecoration.conflictingResourceForeground')),
				tooltip: 'Conflict: resolve it in the working tree, then stage the file'
			}
		};
	}

	dispose(): void {
		clearTimeout(this.refreshTimer);
		vscode.Disposable.from(...this.disposables).dispose();
	}
}

export class RepositoryManager implements vscode.Disposable {
	private readonly repositories = new Map<string, Repository>();
	private readonly didChange = new vscode.EventEmitter<Repository>();
	readonly onDidChange = this.didChange.event;
	private readonly disposables: vscode.Disposable[] = [this.didChange];

	/** Settles when the workspace folders have been scanned. */
	readonly ready: Promise<void>;

	constructor(private readonly log: vscode.LogOutputChannel) {
		this.ready = this.scanFolders(vscode.workspace.workspaceFolders ?? []);
		this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(event => {
			this.scanFolders(event.added).catch(error => this.log.error(error));
		}));
	}

	get all(): Repository[] {
		return [...this.repositories.values()];
	}

	private async scanFolders(folders: readonly vscode.WorkspaceFolder[]): Promise<void> {
		await Promise.all(folders.filter(folder => folder.uri.scheme === 'file').map(folder => this.open(folder.uri.fsPath)));
	}

	private key(root: string): string {
		return process.platform === 'win32' ? root.toLowerCase() : root;
	}

	private async open(folder: string): Promise<Repository | undefined> {
		const git = await GitRepository.open(gitBinary, folder, message => this.log.warn(message));
		if (!git) {
			return undefined;
		}
		const key = this.key(git.root);
		let repository = this.repositories.get(key);
		if (!repository) {
			repository = new Repository(git, this.log);
			this.repositories.set(key, repository);
			const opened = repository;
			this.disposables.push(opened, opened.onDidChange(() => this.didChange.fire(opened)));
			vscode.commands.executeCommand('setContext', 'indexEditor.hasRepository', true);
			await opened.refresh().catch(error => this.log.error(error));
		}
		return repository;
	}

	/** The repository containing a document, opening it if it was not known yet. */
	async repositoryFor(uri: vscode.Uri): Promise<Repository | undefined> {
		await this.ready;
		const candidates = this.all
			.filter(repository => repository.relativePath(uri) !== undefined)
			.sort((a, b) => b.git.root.length - a.git.root.length);
		return candidates[0] ?? this.open(path.dirname(uri.fsPath));
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}
}
