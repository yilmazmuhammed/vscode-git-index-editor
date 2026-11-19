import * as path from 'path';
import * as vscode from 'vscode';
import { Repository, RepositoryManager } from '../repository';
import { Change, Status } from '../typings/git';
import { EMPTY_SCHEME, GIT_SCHEME, INDEX_SCHEME, STAGING_SCHEME, toFileUri } from '../uris';
import {
	buildNodes, Entry, EntryKind, entriesOf, kindLetter, ListKind, markPartial, matchesFilter, Node,
	Presentation, SortOrder, sortEntries
} from './entries';

const MIME: Record<ListKind, string> = {
	unstaged: 'application/vnd.git-index.unstaged',
	staged: 'application/vnd.git-index.staged'
};

const OTHER: Record<ListKind, ListKind> = { unstaged: 'staged', staged: 'unstaged' };

function unstagedKind(status: Status): EntryKind | undefined {
	switch (status) {
		case Status.MODIFIED: return 'modified';
		case Status.DELETED: return 'deleted';
		case Status.UNTRACKED: return 'untracked';
		case Status.INTENT_TO_ADD: return 'added';
		case Status.INTENT_TO_RENAME: return 'renamed';
		case Status.TYPE_CHANGED: return 'typeChanged';
		case Status.ADDED_BY_US:
		case Status.ADDED_BY_THEM:
		case Status.DELETED_BY_US:
		case Status.DELETED_BY_THEM:
		case Status.BOTH_ADDED:
		case Status.BOTH_DELETED:
		case Status.BOTH_MODIFIED:
			return 'conflict';
		default: return undefined;
	}
}

function stagedKind(status: Status): EntryKind | undefined {
	switch (status) {
		case Status.INDEX_MODIFIED: return 'modified';
		case Status.INDEX_ADDED: return 'added';
		case Status.INDEX_DELETED: return 'deleted';
		case Status.INDEX_RENAMED: return 'renamed';
		case Status.INDEX_COPIED: return 'copied';
		default: return undefined;
	}
}

export function kindLabel(kind: EntryKind): string {
	switch (kind) {
		case 'modified': return vscode.l10n.t('Modified');
		case 'added': return vscode.l10n.t('Added');
		case 'deleted': return vscode.l10n.t('Deleted');
		case 'renamed': return vscode.l10n.t('Renamed');
		case 'copied': return vscode.l10n.t('Copied');
		case 'untracked': return vscode.l10n.t('Untracked');
		case 'typeChanged': return vscode.l10n.t('Type changed');
		case 'conflict': return vscode.l10n.t('Conflict');
	}
}

const COLORS: Record<ListKind, Record<EntryKind, string>> = {
	unstaged: {
		modified: 'gitDecoration.modifiedResourceForeground',
		added: 'gitDecoration.addedResourceForeground',
		deleted: 'gitDecoration.deletedResourceForeground',
		renamed: 'gitDecoration.renamedResourceForeground',
		copied: 'gitDecoration.addedResourceForeground',
		untracked: 'gitDecoration.untrackedResourceForeground',
		typeChanged: 'gitDecoration.modifiedResourceForeground',
		conflict: 'gitDecoration.conflictingResourceForeground'
	},
	staged: {
		modified: 'gitDecoration.stageModifiedResourceForeground',
		added: 'gitDecoration.addedResourceForeground',
		deleted: 'gitDecoration.stageDeletedResourceForeground',
		renamed: 'gitDecoration.renamedResourceForeground',
		copied: 'gitDecoration.addedResourceForeground',
		untracked: 'gitDecoration.untrackedResourceForeground',
		typeChanged: 'gitDecoration.stageModifiedResourceForeground',
		conflict: 'gitDecoration.conflictingResourceForeground'
	}
};

/** Colors and letters for the Staging view's items, which carry their list and kind in the URI. */
export class StagingDecorations implements vscode.FileDecorationProvider {
	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.scheme !== STAGING_SCHEME) {
			return undefined;
		}
		const params = new URLSearchParams(uri.query);
		const list = params.get('list') as ListKind | null;
		const kind = params.get('kind') as EntryKind | null;
		if (!list || !kind || !(kind in COLORS[list])) {
			return undefined;
		}
		return new vscode.FileDecoration(kindLetter(kind), kindLabel(kind), new vscode.ThemeColor(COLORS[list][kind]));
	}
}

class StagingTreeProvider implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node> {
	private readonly didChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.didChangeTreeData.event;
	readonly dragMimeTypes: string[];
	readonly dropMimeTypes: string[];
	nodes: Node[] = [];

	constructor(private readonly list: ListKind, private readonly controller: StagingController) {
		this.dragMimeTypes = [MIME[list]];
		this.dropMimeTypes = [MIME[OTHER[list]]];
	}

	update(nodes: Node[]): void {
		this.nodes = nodes;
		this.didChangeTreeData.fire();
	}

	getChildren(node?: Node): Node[] {
		return node ? (node.type === 'folder' ? node.children : []) : this.nodes;
	}

	getTreeItem(node: Node): vscode.TreeItem {
		const root = this.controller.repository?.git.root ?? '';
		if (node.type === 'folder') {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
			item.id = `${this.list}:folder:${node.path}`;
			item.resourceUri = vscode.Uri.file(path.join(root, node.path)).with({ scheme: STAGING_SCHEME, query: `list=${this.list}` });
			item.iconPath = vscode.ThemeIcon.Folder;
			item.contextValue = `${this.list}.folder`;
			return item;
		}
		const entry = node.entry;
		const item = new vscode.TreeItem(path.posix.basename(entry.path), vscode.TreeItemCollapsibleState.None);
		item.id = `${this.list}:file:${entry.path}`;
		item.resourceUri = vscode.Uri.file(path.join(root, entry.path))
			.with({ scheme: STAGING_SCHEME, query: `list=${this.list}&kind=${entry.kind}` });
		const description: string[] = [];
		const folder = path.posix.dirname(entry.path);
		if (this.controller.presentation === 'list' && folder !== '.') {
			description.push(folder);
		}
		if (entry.partial) {
			description.push(vscode.l10n.t('partially staged'));
		}
		item.description = description.join(' • ');
		item.tooltip = entry.originalPath
			? `${entry.originalPath} → ${entry.path} • ${kindLabel(entry.kind)}`
			: `${entry.path} • ${kindLabel(entry.kind)}`;
		item.contextValue = `${this.list}.file.${entry.kind}`;
		item.command = { command: 'indexEditor.staging.open', title: vscode.l10n.t('Open'), arguments: [node] };
		return item;
	}

	handleDrag(source: readonly Node[], dataTransfer: vscode.DataTransfer): void {
		const entries = source.flatMap(entriesOf);
		dataTransfer.set(MIME[this.list], new vscode.DataTransferItem(JSON.stringify(entries)));
	}

	async handleDrop(_target: Node | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
		const item = dataTransfer.get(MIME[OTHER[this.list]]);
		if (!item) {
			return;
		}
		const entries = JSON.parse(await item.asString()) as Entry[];
		await this.controller.drop(this.list, entries);
	}
}

export interface StagingActions {
	stage(repository: Repository, entries: readonly Entry[]): Promise<void>;
	unstage(repository: Repository, entries: readonly Entry[]): Promise<void>;
}

/**
 * The EGit-style Staging view: Unstaged and Staged lists of one repository, read from the
 * built-in Git extension's state.
 */
export class StagingController implements vscode.Disposable {
	private current: Repository | undefined;
	private filterText = '';
	private lists: Record<ListKind, Entry[]> = { unstaged: [], staged: [] };
	private readonly providers: Record<ListKind, StagingTreeProvider>;
	readonly views: Record<ListKind, vscode.TreeView<Node>>;

	private readonly didChangeRepository = new vscode.EventEmitter<Repository | undefined>();
	/** The view switched to another repository. */
	readonly onDidChangeRepository = this.didChangeRepository.event;
	private readonly didUpdate = new vscode.EventEmitter<void>();
	/** The lists were re-read. */
	readonly onDidUpdate = this.didUpdate.event;
	private readonly disposables: vscode.Disposable[] = [this.didChangeRepository, this.didUpdate];

	constructor(private readonly manager: RepositoryManager, private readonly actions: StagingActions) {
		this.providers = {
			unstaged: new StagingTreeProvider('unstaged', this),
			staged: new StagingTreeProvider('staged', this)
		};
		this.views = {
			unstaged: this.createView('unstaged'),
			staged: this.createView('staged')
		};
		// The view shows one repository. The last signal wins: the active editor moving to a file
		// of another repository, a repository selected in the Source Control view, or one chosen
		// with Select Repository or Show in Git Staging. VS Code does not tell extensions what is
		// selected in the Explorer, so a folder there counts only through Show in Git Staging.
		const followEditor = () => {
			if (this.followsActiveEditor) {
				this.follow(this.activeEditorRepository());
			}
		};
		this.disposables.push(
			vscode.window.registerFileDecorationProvider(new StagingDecorations()),
			manager.onDidChangeRepositories(() => this.repositoriesChanged()),
			manager.onDidChange(repository => {
				if (repository === this.current) {
					this.update();
				}
			}),
			manager.onDidSelectInSourceControl(repository => {
				if (this.followsActiveEditor) {
					this.follow(repository);
				}
			}),
			vscode.window.onDidChangeActiveTextEditor(followEditor),
			vscode.window.tabGroups.onDidChangeTabs(followEditor),
			vscode.window.tabGroups.onDidChangeTabGroups(followEditor),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('indexEditor.staging.followActiveEditor')) {
					followEditor();
				}
				if (event.affectsConfiguration('indexEditor.staging')) {
					this.update();
				}
			})
		);
		void manager.ready.then(() => this.repositoriesChanged());
	}

	private createView(list: ListKind): vscode.TreeView<Node> {
		const view = vscode.window.createTreeView(`indexEditor.staging.${list}`, {
			treeDataProvider: this.providers[list],
			dragAndDropController: this.providers[list],
			canSelectMany: true,
			showCollapseAll: true
		});
		this.disposables.push(view);
		return view;
	}

	private get config(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration('indexEditor.staging');
	}

	get presentation(): Presentation {
		return this.config.get<Presentation>('presentation', 'list');
	}

	private get sortOrder(): SortOrder {
		return this.config.get<SortOrder>('sortBy', 'name');
	}

	private get showUntracked(): boolean {
		return this.config.get<boolean>('showUntracked', true);
	}

	private get followsActiveEditor(): boolean {
		return this.config.get<boolean>('followActiveEditor', true);
	}

	get repository(): Repository | undefined {
		return this.current;
	}

	get filter(): string {
		return this.filterText;
	}

	/** The entries of a list after the untracked setting, before the filter. */
	entries(list: ListKind): readonly Entry[] {
		return this.lists[list];
	}

	setFilter(filter: string): void {
		this.filterText = filter.trim();
		void vscode.commands.executeCommand('setContext', 'indexEditor.staging.filtered', this.filterText.length > 0);
		this.update();
	}

	/** Shows a repository, e.g. one picked with Select Repository or Show in Git Staging. */
	selectRepository(repository: Repository): void {
		this.follow(repository);
	}

	/** Switches to a repository, if it is a different one. */
	private follow(repository: Repository | undefined): void {
		if (!repository || repository === this.current || !this.manager.all.includes(repository)) {
			return;
		}
		this.current = repository;
		this.didChangeRepository.fire(repository);
		this.update();
	}

	/** After repositories were opened or closed: keep the current one, or take the active editor's, or the first. */
	private repositoriesChanged(): void {
		const all = this.manager.all;
		const fromEditor = this.followsActiveEditor ? this.activeEditorRepository() : undefined;
		const next = fromEditor ?? (this.current && all.includes(this.current) ? this.current : all[0]);
		if (next !== this.current) {
			this.current = next;
			this.didChangeRepository.fire(next);
		}
		this.update();
	}

	/** The file of the active editor tab, whatever kind of editor it is. */
	private static activeResource(): vscode.Uri | undefined {
		const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) {
			return input.uri;
		}
		if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) {
			return input.modified;
		}
		return vscode.window.activeTextEditor?.document.uri;
	}

	private activeEditorRepository(): Repository | undefined {
		const uri = StagingController.activeResource();
		if (!uri || !['file', INDEX_SCHEME, GIT_SCHEME, EMPTY_SCHEME].includes(uri.scheme)) {
			return undefined;
		}
		return this.manager.innermost(toFileUri(uri));
	}

	/** The entries of a list of any repository, untracked files included whatever the view shows. */
	allEntries(repository: Repository, list: ListKind): Entry[] {
		return this.readState(repository, true)[list];
	}

	private readState(repository: Repository, includeUntracked = this.showUntracked): Record<ListKind, Entry[]> {
		const state = repository.api.state;
		const toEntries = (list: ListKind, changes: readonly Change[], kindOf: (status: Status) => EntryKind | undefined) =>
			changes.flatMap((change): Entry[] => {
				const kind = kindOf(change.status);
				const file = repository.relativePath(change.renameUri ?? change.uri);
				if (!kind || file === undefined) {
					return [];
				}
				const original = kind === 'renamed' || kind === 'copied' ? repository.relativePath(change.originalUri) : undefined;
				return [{ list, path: file, originalPath: original !== file ? original : undefined, kind, partial: false }];
			});
		const seen = new Set<string>();
		const unstaged = [
			...toEntries('unstaged', state.mergeChanges, unstagedKind),
			...toEntries('unstaged', state.workingTreeChanges, unstagedKind),
			...toEntries('unstaged', state.untrackedChanges ?? [], unstagedKind)
		].filter(entry => !seen.has(entry.path) && seen.add(entry.path))
			.filter(entry => includeUntracked || entry.kind !== 'untracked');
		return markPartial(unstaged, toEntries('staged', state.indexChanges, stagedKind));
	}

	/** Where the view's repository stands: its name and the checked-out branch, or the commit if HEAD is detached. */
	describeRepository(): string | undefined {
		const repository = this.current;
		if (!repository) {
			return undefined;
		}
		const head = repository.api.state.HEAD;
		const at = head?.name ?? head?.commit?.slice(0, 8);
		return at ? `${repository.name} • ${at}` : repository.name;
	}

	/** Re-reads the lists of the view's repository. */
	update(): void {
		if (this.current && !this.manager.all.includes(this.current)) {
			this.repositoriesChanged();
			return;
		}
		const repository = this.current;
		this.lists = repository ? this.readState(repository) : { unstaged: [], staged: [] };
		for (const list of ['unstaged', 'staged'] as const) {
			const all = this.lists[list];
			const visible = sortEntries(all.filter(entry => matchesFilter(entry.path, this.filterText)), this.sortOrder);
			this.providers[list].update(buildNodes(list, visible, this.presentation));
			const view = this.views[list];
			const title = list === 'unstaged' ? vscode.l10n.t('Unstaged Changes') : vscode.l10n.t('Staged Changes');
			view.title = this.filterText ? `${title} (${visible.length}/${all.length})` : `${title} (${all.length})`;
			view.description = this.describeRepository();
			view.message = !repository
				? vscode.l10n.t('No Git repository is open.')
				: this.filterText && all.length && !visible.length
					? vscode.l10n.t('No file matches the filter "{0}".', this.filterText)
					: undefined;
		}
		this.didUpdate.fire();
	}

	/** The entries a command applies to: the clicked node or the multi-selection, else the view's selection. */
	entriesFromArgs(list: ListKind, args: readonly unknown[]): Entry[] {
		const [clicked, selected] = args as [Node | undefined, Node[] | undefined];
		let nodes: readonly Node[];
		if (Array.isArray(selected) && selected.length) {
			nodes = selected;
		} else if (clicked && typeof clicked === 'object' && 'type' in clicked) {
			nodes = [clicked];
		} else {
			nodes = this.views[list].selection;
		}
		const unique = new Map<string, Entry>();
		for (const entry of nodes.flatMap(entriesOf)) {
			unique.set(entry.path, entry);
		}
		return [...unique.values()];
	}

	async drop(target: ListKind, entries: readonly Entry[]): Promise<void> {
		const repository = this.current;
		if (!repository || !entries.length) {
			return;
		}
		await (target === 'staged' ? this.actions.stage(repository, entries) : this.actions.unstage(repository, entries));
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}
}
