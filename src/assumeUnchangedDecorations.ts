import * as vscode from 'vscode';
import { Repository, RepositoryManager } from './repository';

const DELAY = 500;

/**
 * Marks files flagged assume-unchanged in the Explorer, as EGit's label decorations do. Git hides
 * their changes, so without a mark nothing shows that edits to them will not be committed.
 */
export class AssumeUnchangedDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
	private readonly didChange = new vscode.EventEmitter<vscode.Uri[]>();
	readonly onDidChangeFileDecorations = this.didChange.event;
	private readonly files = new Map<Repository, Set<string>>();
	private readonly timers = new Map<Repository, NodeJS.Timeout>();
	private readonly disposables: vscode.Disposable[] = [this.didChange];

	constructor(private readonly manager: RepositoryManager, private readonly log: vscode.LogOutputChannel) {
		this.disposables.push(
			vscode.window.registerFileDecorationProvider(this),
			manager.onDidChange(repository => this.schedule(repository)),
			manager.onDidChangeRepositories(() => manager.all.forEach(repository => this.schedule(repository))),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('indexEditor.decorations.assumeUnchanged')) {
					manager.all.forEach(repository => this.schedule(repository));
				}
			})
		);
		void manager.ready.then(() => manager.all.forEach(repository => this.schedule(repository)));
	}

	private get enabled(): boolean {
		return vscode.workspace.getConfiguration('indexEditor.decorations').get<boolean>('assumeUnchanged', true);
	}

	private schedule(repository: Repository): void {
		clearTimeout(this.timers.get(repository));
		this.timers.set(repository, setTimeout(() => {
			this.timers.delete(repository);
			this.update(repository).catch(error => this.log.warn(String(error)));
		}, DELAY));
	}

	private async update(repository: Repository): Promise<void> {
		const before = this.files.get(repository) ?? new Set<string>();
		const after = new Set(this.enabled && this.manager.all.includes(repository) ? await repository.git.assumeUnchangedFiles() : []);
		const changed = [...before, ...after].filter(file => before.has(file) !== after.has(file));
		this.files.set(repository, after);
		if (changed.length) {
			this.didChange.fire(changed.map(file => repository.fileUri(file)));
		}
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.scheme !== 'file') {
			return undefined;
		}
		const repository = this.manager.innermost(uri);
		const file = repository && repository.relativePath(uri);
		if (!repository || file === undefined || !this.files.get(repository)?.has(file)) {
			return undefined;
		}
		return new vscode.FileDecoration('AU', vscode.l10n.t('Assume unchanged: Git ignores changes to this file'),
			new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'));
	}

	dispose(): void {
		this.timers.forEach(timer => clearTimeout(timer));
		vscode.Disposable.from(...this.disposables).dispose();
	}
}
