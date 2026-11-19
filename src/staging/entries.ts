/*
 * The Staging view's data, free of VS Code types so that it can be unit tested.
 */

export type ListKind = 'unstaged' | 'staged';

export type EntryKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'typeChanged' | 'conflict';

export interface Entry {
	readonly list: ListKind;
	/** Path relative to the repository root, with forward slashes. */
	readonly path: string;
	/** For a rename, the path before it. */
	readonly originalPath?: string;
	readonly kind: EntryKind;
	/** The file also has changes in the other list. */
	readonly partial: boolean;
}

export type Presentation = 'list' | 'tree' | 'compactTree';
export type SortOrder = 'name' | 'status';

export interface FileNode {
	readonly type: 'file';
	readonly entry: Entry;
}

export interface FolderNode {
	readonly type: 'folder';
	readonly list: ListKind;
	/** Folder path relative to the repository root. */
	readonly path: string;
	/** What the tree shows: the folder name, or several joined by `/` in the compact tree. */
	readonly label: string;
	readonly children: Node[];
}

export type Node = FileNode | FolderNode;

const LETTERS: Record<EntryKind, string> = {
	modified: 'M',
	added: 'A',
	deleted: 'D',
	renamed: 'R',
	copied: 'C',
	untracked: 'U',
	typeChanged: 'T',
	conflict: '!'
};

const STATUS_ORDER: EntryKind[] = ['conflict', 'modified', 'typeChanged', 'renamed', 'copied', 'added', 'deleted', 'untracked'];

export function kindLetter(kind: EntryKind): string {
	return LETTERS[kind];
}

/** Marks the entries whose path is in both lists. */
export function markPartial(unstaged: readonly Entry[], staged: readonly Entry[]): { unstaged: Entry[]; staged: Entry[] } {
	const inUnstaged = new Set(unstaged.filter(entry => entry.kind !== 'untracked').map(entry => entry.path));
	const inStaged = new Set(staged.map(entry => entry.path));
	return {
		unstaged: unstaged.map(entry => ({ ...entry, partial: inStaged.has(entry.path) })),
		staged: staged.map(entry => ({ ...entry, partial: inUnstaged.has(entry.path) }))
	};
}

function escapeRegExp(text: string): string {
	return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a path passes the file filter: a case-insensitive substring of the path, in which `*`
 * stands for any run of characters and `?` for one character, as in EGit.
 */
export function matchesFilter(path: string, filter: string): boolean {
	const pattern = filter.trim();
	if (!pattern) {
		return true;
	}
	const source = escapeRegExp(pattern).replace(/\*/g, '.*').replace(/\?/g, '.');
	return new RegExp(source, 'i').test(path);
}

function comparePaths(a: string, b: string): number {
	const lowerA = a.toLowerCase();
	const lowerB = b.toLowerCase();
	return lowerA < lowerB ? -1 : lowerA > lowerB ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

export function sortEntries(entries: readonly Entry[], order: SortOrder): Entry[] {
	return [...entries].sort((a, b) => {
		if (order === 'status') {
			const byStatus = STATUS_ORDER.indexOf(a.kind) - STATUS_ORDER.indexOf(b.kind);
			if (byStatus) {
				return byStatus;
			}
		}
		return comparePaths(a.path, b.path);
	});
}

interface MutableFolder {
	readonly path: string;
	readonly folders: Map<string, MutableFolder>;
	readonly files: Entry[];
}

function freeze(list: ListKind, folder: MutableFolder, compact: boolean): Node[] {
	const folders = [...folder.folders.entries()]
		.sort(([a], [b]) => comparePaths(a, b))
		.map(([name, child]): FolderNode => {
			let label = name;
			let current = child;
			while (compact && current.files.length === 0 && current.folders.size === 1) {
				const [[nextName, next]] = current.folders.entries();
				label = `${label}/${nextName}`;
				current = next;
			}
			return { type: 'folder', list, path: current.path, label, children: freeze(list, current, compact) };
		});
	const files = folder.files.map((entry): FileNode => ({ type: 'file', entry }));
	return [...folders, ...files];
}

/** The nodes the view shows: files in the given order, under folders unless the presentation is a list. */
export function buildNodes(list: ListKind, entries: readonly Entry[], presentation: Presentation): Node[] {
	if (presentation === 'list') {
		return entries.map(entry => ({ type: 'file', entry }));
	}
	const root: MutableFolder = { path: '', folders: new Map(), files: [] };
	for (const entry of entries) {
		const parts = entry.path.split('/');
		let folder = root;
		for (const part of parts.slice(0, -1)) {
			let child = folder.folders.get(part);
			if (!child) {
				child = { path: folder.path ? `${folder.path}/${part}` : part, folders: new Map(), files: [] };
				folder.folders.set(part, child);
			}
			folder = child;
		}
		folder.files.push(entry);
	}
	return freeze(list, root, presentation === 'compactTree');
}

/** The file entries a node stands for. */
export function entriesOf(node: Node): Entry[] {
	return node.type === 'file' ? [node.entry] : node.children.flatMap(entriesOf);
}

/** The paths Git has to be told about for an entry: both sides of a rename. */
export function pathsOf(entries: readonly Entry[]): string[] {
	return [...new Set(entries.flatMap(entry => entry.originalPath ? [entry.path, entry.originalPath] : [entry.path]))];
}
