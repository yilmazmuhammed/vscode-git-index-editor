import * as path from 'path';
import * as vscode from 'vscode';
import { GitRepository } from './git';
import type { API, Repository as ApiRepository } from './typings/git';
import { toFileUri } from './uris';

/**
 * A repository the built-in Git extension has open. Its state (changes, HEAD, remotes) and the
 * events that report changes come from that extension; `git` runs the commands its API lacks.
 */
export class Repository implements vscode.Disposable {
	readonly rootUri: vscode.Uri;

	private readonly didChange = new vscode.EventEmitter<void>();
	/** Fires whenever the built-in extension has re-read the repository's status. */
	readonly onDidChange = this.didChange.event;
	private readonly didChangeSelection = new vscode.EventEmitter<void>();
	/** The repository was selected or deselected in the Source Control view. */
	readonly onDidChangeSelection = this.didChangeSelection.event;
	private readonly disposables: vscode.Disposable[] = [this.didChange, this.didChangeSelection];

	constructor(readonly api: ApiRepository, readonly git: GitRepository) {
		this.rootUri = vscode.Uri.file(git.root);
		this.disposables.push(api.state.onDidChange(() => this.didChange.fire()));
		if (api.ui) {
			this.disposables.push(api.ui.onDidChange(() => this.didChangeSelection.fire()));
		}
	}

	get name(): string {
		return path.basename(this.git.root);
	}

	/** The path of a document inside this repository, or undefined if it lies outside. */
	relativePath(uri: vscode.Uri): string | undefined {
		const relative = path.relative(this.git.root, uri.fsPath);
		if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
			return undefined;
		}
		return relative.split(path.sep).join('/');
	}

	fileUri(relative: string): vscode.Uri {
		return vscode.Uri.file(path.join(this.git.root, relative));
	}

	/** Asks the built-in extension to re-read the status now instead of waiting for its watcher. */
	refresh(): Promise<void> {
		return this.api.status();
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}
}

/** Identifies a repository by its root folder, compared the way the file system does. */
function rootKey(root: vscode.Uri): string {
	const normalized = path.normalize(root.fsPath);
	return process.platform === 'linux' ? normalized : normalized.toLowerCase();
}

/**
 * Follows the repositories of the built-in Git extension. Its API hands out a new wrapper object
 * for the same repository on every access and event, so repositories are matched by root folder.
 */
export class RepositoryManager implements vscode.Disposable {
	private readonly repositories = new Map<string, Promise<Repository | undefined>>();
	private readonly opened: Repository[] = [];

	private readonly didChange = new vscode.EventEmitter<Repository>();
	/** A repository's status changed. */
	readonly onDidChange = this.didChange.event;
	private readonly didChangeRepositories = new vscode.EventEmitter<void>();
	/** A repository was opened or closed. */
	readonly onDidChangeRepositories = this.didChangeRepositories.event;
	private readonly didSelectInSourceControl = new vscode.EventEmitter<Repository>();
	/** The user selected a repository in the Source Control view. */
	readonly onDidSelectInSourceControl = this.didSelectInSourceControl.event;
	private readonly disposables: vscode.Disposable[] = [this.didChange, this.didChangeRepositories, this.didSelectInSourceControl];

	/** The repositories selected in the Source Control view when last looked at, and the last one reported. */
	private selectedInSourceControl = new Set<Repository>();
	private lastSelectedInSourceControl: Repository | undefined;

	/** Settles when the built-in extension has finished its first scan of the workspace. */
	readonly ready: Promise<void>;

	constructor(private readonly gitApi: API, private readonly log: vscode.LogOutputChannel) {
		this.disposables.push(
			gitApi.onDidOpenRepository(repository => void this.add(repository)),
			gitApi.onDidCloseRepository(repository => this.remove(repository))
		);
		this.ready = this.initialize();
	}

	private async initialize(): Promise<void> {
		if (this.gitApi.state !== 'initialized') {
			await new Promise<void>(resolve => {
				const listener = this.gitApi.onDidChangeState(state => {
					if (state === 'initialized') {
						listener.dispose();
						resolve();
					}
				});
			});
		}
		await Promise.all(this.gitApi.repositories.map(repository => this.add(repository)));
	}

	get all(): Repository[] {
		return [...this.opened];
	}

	private add(apiRepository: ApiRepository): Promise<Repository | undefined> {
		const key = rootKey(apiRepository.rootUri);
		let pending = this.repositories.get(key);
		if (!pending) {
			pending = (async () => {
				const git = await GitRepository.open(() => this.gitApi.git.path, apiRepository.rootUri.fsPath,
					message => this.log.warn(message));
				if (!git || this.repositories.get(key) !== pending) {
					return undefined;
				}
				const repository = new Repository(apiRepository, git);
				repository.onDidChange(() => this.didChange.fire(repository));
				repository.onDidChangeSelection(() => this.sourceControlSelectionChanged());
				if (apiRepository.ui?.selected) {
					this.selectedInSourceControl.add(repository);
				}
				this.opened.push(repository);
				this.updateContext();
				this.didChangeRepositories.fire();
				return repository;
			})();
			this.repositories.set(key, pending);
		}
		return pending;
	}

	private remove(apiRepository: ApiRepository): void {
		const key = rootKey(apiRepository.rootUri);
		const index = this.opened.findIndex(repository => rootKey(repository.rootUri) === key);
		this.repositories.delete(key);
		if (index >= 0) {
			const [repository] = this.opened.splice(index, 1);
			repository.dispose();
			this.updateContext();
			this.didChangeRepositories.fire();
		}
	}

	/**
	 * Reports a repository the user picked in the Source Control view: the one that became
	 * selected, or the only one left selected (single selection mode deselects the others).
	 */
	private sourceControlSelectionChanged(): void {
		const now = new Set(this.opened.filter(repository => repository.api.ui?.selected));
		const added = [...now].filter(repository => !this.selectedInSourceControl.has(repository));
		this.selectedInSourceControl = now;
		const picked = added.length === 1 ? added[0] : !added.length && now.size === 1 ? [...now][0] : undefined;
		if (picked && picked !== this.lastSelectedInSourceControl) {
			this.lastSelectedInSourceControl = picked;
			this.didSelectInSourceControl.fire(picked);
		}
	}

	private updateContext(): void {
		void vscode.commands.executeCommand('setContext', 'indexEditor.hasRepository', this.opened.length > 0);
		void vscode.commands.executeCommand('setContext', 'indexEditor.multipleRepositories', this.opened.length > 1);
	}

	/** The innermost open repository containing a document, of any scheme that keeps the file path. */
	async repositoryFor(uri: vscode.Uri): Promise<Repository | undefined> {
		await this.ready;
		const file = toFileUri(uri);
		const known = this.innermost(file);
		if (known) {
			return known;
		}
		const apiRepository = this.gitApi.getRepository(file);
		return apiRepository ? this.add(apiRepository) : undefined;
	}

	/** Like repositoryFor, among the repositories already wrapped, without waiting. */
	innermost(uri: vscode.Uri): Repository | undefined {
		const file = toFileUri(uri);
		return this.opened
			.filter(repository => repository.relativePath(file) !== undefined)
			.sort((a, b) => b.git.root.length - a.git.root.length)[0];
	}

	dispose(): void {
		vscode.Disposable.from(...this.opened, ...this.disposables).dispose();
	}
}
