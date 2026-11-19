import * as vscode from 'vscode';
import { Operation } from '../git';
import { Repository, RepositoryManager } from '../repository';
import { EMPTY_SCHEME, GIT_SCHEME, INDEX_SCHEME, toFileUri } from '../uris';
import { readRefs, readRemotes } from './branchService';
import { buildRefTree, RefFolder, RefInfo, RefTreeNode, RemoteInfo } from './model';

export type GroupKind = 'branches' | 'local' | 'remoteTracking' | 'references' | 'remotes';

export type RepositoryTreeNode =
	| { readonly kind: 'repository'; readonly repository: Repository }
	| { readonly kind: 'group'; readonly repository: Repository; readonly group: GroupKind }
	| { readonly kind: 'refFolder'; readonly repository: Repository; readonly group: 'local' | 'remoteTracking'; readonly folder: RefFolder }
	| { readonly kind: 'ref'; readonly repository: Repository; readonly ref: RefInfo; readonly label: string }
	| { readonly kind: 'reference'; readonly repository: Repository; readonly name: string; readonly commit: string; readonly subject: string }
	| { readonly kind: 'remote'; readonly repository: Repository; readonly remote: RemoteInfo }
	| { readonly kind: 'remoteSpec'; readonly repository: Repository; readonly remote: RemoteInfo; readonly direction: 'fetch' | 'push' };

/** The special refs EGit lists under References. */
const REFERENCES = ['HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];

const OPERATION_LABELS: Record<Operation, string> = {
	none: '',
	merge: 'MERGING',
	rebase: 'REBASING',
	cherryPick: 'CHERRY-PICKING',
	revert: 'REVERTING'
};

interface RepositoryData {
	readonly refs: RefInfo[];
	readonly remotes: RemoteInfo[];
}

const REFRESH_DELAY = 300;

/** EGit's Git Repositories view: repositories with their branches, special references and remotes. */
export class RepositoriesView implements vscode.TreeDataProvider<RepositoryTreeNode>, vscode.Disposable {
	private readonly didChangeTreeData = new vscode.EventEmitter<RepositoryTreeNode | undefined>();
	readonly onDidChangeTreeData = this.didChangeTreeData.event;
	readonly treeView: vscode.TreeView<RepositoryTreeNode>;

	/** One node object per repository, so that the view can reveal and refresh it. */
	private readonly repositoryNodes = new Map<Repository, RepositoryTreeNode & { kind: 'repository' }>();
	private readonly data = new Map<Repository, Promise<RepositoryData>>();
	private readonly timers = new Map<Repository, NodeJS.Timeout>();
	private readonly disposables: vscode.Disposable[] = [this.didChangeTreeData];

	constructor(private readonly manager: RepositoryManager) {
		this.treeView = vscode.window.createTreeView('indexEditor.repositories', {
			treeDataProvider: this,
			canSelectMany: true,
			showCollapseAll: true
		});
		const reveal = () => void this.revealActiveRepository();
		this.disposables.push(
			this.treeView,
			manager.onDidChangeRepositories(() => this.refresh()),
			manager.onDidChange(repository => this.schedule(repository)),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('indexEditor.repositories')) {
					this.refresh();
				}
			}),
			vscode.window.onDidChangeActiveTextEditor(reveal),
			this.treeView.onDidChangeVisibility(reveal)
		);
	}

	private get config(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration('indexEditor.repositories');
	}

	/** Re-reads everything, or one repository. */
	refresh(repository?: Repository): void {
		if (repository) {
			this.data.delete(repository);
			this.didChangeTreeData.fire(this.repositoryNodes.get(repository));
		} else {
			this.data.clear();
			this.didChangeTreeData.fire(undefined);
		}
	}

	private schedule(repository: Repository): void {
		clearTimeout(this.timers.get(repository));
		this.timers.set(repository, setTimeout(() => {
			this.timers.delete(repository);
			this.refresh(repository);
		}, REFRESH_DELAY));
	}

	private load(repository: Repository): Promise<RepositoryData> {
		let data = this.data.get(repository);
		if (!data) {
			data = Promise.all([readRefs(repository), readRemotes(repository)]).then(([refs, remotes]) => ({ refs, remotes }));
			this.data.set(repository, data);
			data.catch(() => this.data.delete(repository));
		}
		return data;
	}

	repositoryNode(repository: Repository): RepositoryTreeNode & { kind: 'repository' } {
		let node = this.repositoryNodes.get(repository);
		if (!node) {
			node = { kind: 'repository', repository };
			this.repositoryNodes.set(repository, node);
		}
		return node;
	}

	/** EGit's Link with Editor: selects the repository of the active editor. */
	private async revealActiveRepository(): Promise<void> {
		if (!this.treeView.visible || !this.config.get<boolean>('linkWithEditor', true)) {
			return;
		}
		const uri = vscode.window.activeTextEditor?.document.uri;
		if (!uri || !['file', INDEX_SCHEME, GIT_SCHEME, EMPTY_SCHEME].includes(uri.scheme)) {
			return;
		}
		const repository = this.manager.innermost(toFileUri(uri));
		const selected = this.treeView.selection;
		if (repository && !(selected.length === 1 && selected[0].kind === 'repository' && selected[0].repository === repository)) {
			await this.treeView.reveal(this.repositoryNode(repository), { select: true, focus: false, expand: false }).then(undefined, () => undefined);
		}
	}

	getParent(node: RepositoryTreeNode): RepositoryTreeNode | undefined {
		return node.kind === 'repository' ? undefined : this.repositoryNode(node.repository);
	}

	async getChildren(node?: RepositoryTreeNode): Promise<RepositoryTreeNode[]> {
		if (!node) {
			await this.manager.ready;
			return this.manager.all
				.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
				.map(repository => this.repositoryNode(repository));
		}
		const repository = node.repository;
		switch (node.kind) {
			case 'repository':
				return (['branches', 'references', 'remotes'] as const).map(group => ({ kind: 'group', repository, group }));
			case 'group':
				return this.groupChildren(repository, node.group);
			case 'refFolder':
				return node.folder.children.map(child => this.refNode(repository, node.group, child));
			case 'remote':
				return (['fetch', 'push'] as const).map(direction => ({ kind: 'remoteSpec', repository, remote: node.remote, direction }));
			default:
				return [];
		}
	}

	private refNode(repository: Repository, group: 'local' | 'remoteTracking', child: RefTreeNode): RepositoryTreeNode {
		return child.type === 'folder'
			? { kind: 'refFolder', repository, group, folder: child }
			: { kind: 'ref', repository, ref: child.ref, label: child.label };
	}

	private async groupChildren(repository: Repository, group: GroupKind): Promise<RepositoryTreeNode[]> {
		const hierarchical = this.config.get<boolean>('hierarchicalBranches', true);
		switch (group) {
			case 'branches':
				return (['local', 'remoteTracking'] as const).map(kind => ({ kind: 'group', repository, group: kind }));
			case 'local':
			case 'remoteTracking': {
				const { refs } = await this.load(repository);
				const wanted = refs.filter(ref => ref.kind === (group === 'local' ? 'local' : 'remote'));
				return buildRefTree(wanted, hierarchical).map(child => this.refNode(repository, group, child));
			}
			case 'references': {
				const nodes: RepositoryTreeNode[] = [];
				for (const name of REFERENCES) {
					const commit = await repository.git.resolveCommit(name);
					if (commit) {
						const subject = (await repository.git.run(['log', '-1', '--format=%s', commit])).toString('utf8').trim();
						nodes.push({ kind: 'reference', repository, name, commit, subject });
					}
				}
				return nodes;
			}
			case 'remotes': {
				const { remotes } = await this.load(repository);
				return remotes
					.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
					.map(remote => ({ kind: 'remote', repository, remote }));
			}
		}
	}

	async getTreeItem(node: RepositoryTreeNode): Promise<vscode.TreeItem> {
		const t = vscode.l10n.t;
		const collapsed = vscode.TreeItemCollapsibleState.Collapsed;
		const expanded = vscode.TreeItemCollapsibleState.Expanded;
		const none = vscode.TreeItemCollapsibleState.None;
		switch (node.kind) {
			case 'repository': {
				const repository = node.repository;
				const item = new vscode.TreeItem(repository.name, this.manager.all.length === 1 ? expanded : collapsed);
				item.id = `repository:${repository.git.root}`;
				item.iconPath = new vscode.ThemeIcon('repo');
				item.contextValue = 'repository';
				item.description = await this.describeRepository(repository);
				item.tooltip = repository.git.root;
				return item;
			}
			case 'group': {
				const labels: Record<GroupKind, string> = {
					branches: t('Branches'),
					local: t('Local'),
					remoteTracking: t('Remote Tracking'),
					references: t('References'),
					remotes: t('Remotes')
				};
				const icons: Record<GroupKind, string> = {
					branches: 'git-branch',
					local: 'folder',
					remoteTracking: 'cloud',
					references: 'references',
					remotes: 'remote-explorer'
				};
				const open = node.group === 'branches' || node.group === 'local';
				const item = new vscode.TreeItem(labels[node.group], open ? expanded : collapsed);
				item.id = `${node.repository.git.root}:group:${node.group}`;
				item.iconPath = new vscode.ThemeIcon(icons[node.group]);
				item.contextValue = `group.${node.group}`;
				return item;
			}
			case 'refFolder': {
				const item = new vscode.TreeItem(node.folder.label, node.group === 'local' ? expanded : collapsed);
				item.id = `${node.repository.git.root}:${node.group}:folder:${node.folder.path}`;
				item.iconPath = vscode.ThemeIcon.Folder;
				item.contextValue = 'refFolder';
				return item;
			}
			case 'ref': {
				const ref = node.ref;
				const item = new vscode.TreeItem(node.label, none);
				item.id = `${node.repository.git.root}:${ref.fullName}`;
				const description: string[] = [];
				if (ref.kind === 'local' && ref.upstream) {
					const track = ref.upstreamGone ? t('gone') : [ref.ahead ? `↑${ref.ahead}` : '', ref.behind ? `↓${ref.behind}` : ''].filter(Boolean).join(' ');
					description.push(track ? `${ref.upstream} ${track}` : ref.upstream);
				}
				if (this.config.get<boolean>('showLatestCommit', false)) {
					description.push(`${ref.commit.slice(0, 7)} ${ref.subject}`);
				}
				item.description = description.join(' • ');
				item.tooltip = new vscode.MarkdownString(undefined, true);
				item.tooltip.appendText(ref.fullName);
				if (ref.upstream) {
					item.tooltip.appendText(`\n${t('Upstream: {0}', ref.upstream)}`);
				}
				item.tooltip.appendText(`\n${ref.commit.slice(0, 10)} ${ref.subject}`);
				item.iconPath = new vscode.ThemeIcon(ref.isHead ? 'check' : ref.kind === 'remote' ? 'cloud' : 'git-branch');
				item.contextValue = ref.kind === 'local' ? (ref.isHead ? 'branch.local.head' : 'branch.local') : 'branch.remote';
				return item;
			}
			case 'reference': {
				const item = new vscode.TreeItem(node.name, none);
				item.id = `${node.repository.git.root}:reference:${node.name}`;
				item.description = `${node.commit.slice(0, 7)} ${node.subject}`;
				item.tooltip = `${node.name}\n${node.commit}\n${node.subject}`;
				item.iconPath = new vscode.ThemeIcon('git-commit');
				item.contextValue = 'reference';
				return item;
			}
			case 'remote': {
				const item = new vscode.TreeItem(node.remote.name, collapsed);
				item.id = `${node.repository.git.root}:remote:${node.remote.name}`;
				item.description = node.remote.url;
				item.tooltip = node.remote.url;
				item.iconPath = new vscode.ThemeIcon('remote');
				item.contextValue = 'remote';
				return item;
			}
			case 'remoteSpec': {
				const fetch = node.direction === 'fetch';
				const remote = node.remote;
				const urls = fetch ? [remote.url] : remote.pushUrls.length ? remote.pushUrls : [remote.url];
				const specs = fetch ? remote.fetch : remote.push;
				const item = new vscode.TreeItem(fetch ? t('Fetch') : t('Push'), none);
				item.id = `${node.repository.git.root}:remote:${remote.name}:${node.direction}`;
				item.description = urls.join(', ');
				item.tooltip = [...urls, ...specs.length ? ['', ...specs] : []].join('\n');
				item.iconPath = new vscode.ThemeIcon(fetch ? 'cloud-download' : 'cloud-upload');
				item.contextValue = `remote.${node.direction}`;
				return item;
			}
		}
	}

	/** `main ↑1 ↓2 | MERGING`, as EGit labels a repository. */
	private async describeRepository(repository: Repository): Promise<string> {
		const head = repository.api.state.HEAD;
		const parts: string[] = [];
		parts.push(head?.name ?? (head?.commit ? head.commit.slice(0, 7) : ''));
		if (head?.ahead) {
			parts.push(`↑${head.ahead}`);
		}
		if (head?.behind) {
			parts.push(`↓${head.behind}`);
		}
		const operation = await repository.git.operation();
		if (operation !== 'none') {
			parts.push(`| ${OPERATION_LABELS[operation]}`);
		}
		return parts.filter(Boolean).join(' ');
	}

	/** The repositories a command applies to: the clicked or selected nodes', else the only one, else none. */
	repositoriesFromArgs(args: readonly unknown[]): Repository[] {
		const nodes = this.nodesFromArgs(args);
		const repositories = [...new Set(nodes.map(node => node.repository))];
		if (repositories.length) {
			return repositories;
		}
		return this.manager.all.length === 1 ? this.manager.all : [];
	}

	/** Like nodesFromArgs, but falls back to the view's selection, for key bindings that pass no node. */
	nodesOrSelection(args: readonly unknown[]): RepositoryTreeNode[] {
		const nodes = this.nodesFromArgs(args);
		return nodes.length ? nodes : [...this.treeView.selection];
	}

	/** The clicked node, or the multi-selection it is part of. */
	nodesFromArgs(args: readonly unknown[]): RepositoryTreeNode[] {
		const [clicked, selected] = args as [RepositoryTreeNode | undefined, RepositoryTreeNode[] | undefined];
		if (Array.isArray(selected) && selected.length) {
			return selected;
		}
		return clicked && typeof clicked === 'object' && 'kind' in clicked && 'repository' in clicked ? [clicked] : [];
	}

	dispose(): void {
		this.timers.forEach(timer => clearTimeout(timer));
		vscode.Disposable.from(...this.disposables).dispose();
	}
}
