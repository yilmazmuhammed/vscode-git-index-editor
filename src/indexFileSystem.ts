import * as vscode from 'vscode';
import { isInlineDiff } from './diffMode';
import { GITLINK_MODE, TreeEntry } from './git';
import { Repository, RepositoryManager } from './repository';
import { INDEX_SCHEME } from './uris';

interface Tracked {
	oid: string | undefined;
	mtime: number;
}

/** Bytes looked at to decide whether a blob is binary, as Git does. */
const BINARY_PROBE = 8000;

/**
 * Exposes the Index (`git-index:`) as writable files, so the regular text and diff editors work on
 * it. A path missing from the Index reads as an empty file: that is what the diff should show, and
 * saving such a document adds the file to the Index. Submodules and binary blobs are read-only.
 */
export class IndexFileSystem implements vscode.FileSystemProvider {
	private readonly didChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.didChangeFile.event;

	/**
	 * Blobs have no timestamps, but VS Code needs mtime to grow when a file changes: that is how
	 * it decides to reload a document and detects saving over a newer version.
	 */
	private readonly tracked = new Map<string, Tracked>();
	private readonly binary = new Map<string, boolean>();

	constructor(private readonly manager: RepositoryManager) { }

	private async locate(uri: vscode.Uri): Promise<{ repository: Repository; file: string; entry: TreeEntry | undefined }> {
		const repository = await this.manager.repositoryFor(uri);
		const file = repository?.relativePath(uri);
		if (!repository || file === undefined) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		return { repository, file, entry: await repository.git.indexEntry(file) };
	}

	/** Records the object a path currently points to and returns its mtime. */
	private track(uri: vscode.Uri, oid: string | undefined): { mtime: number; changed: boolean } {
		const key = uri.toString();
		const known = this.tracked.get(key);
		if (known && known.oid === oid) {
			return { mtime: known.mtime, changed: false };
		}
		const mtime = Math.max(Date.now(), (known?.mtime ?? 0) + 1);
		this.tracked.set(key, { oid, mtime });
		return { mtime, changed: known !== undefined };
	}

	private async isBinary(repository: Repository, oid: string): Promise<boolean> {
		let known = this.binary.get(oid);
		if (known === undefined) {
			const content = await repository.git.readBlob(oid);
			known = content.subarray(0, BINARY_PROBE).includes(0);
			this.binary.set(oid, known);
		}
		return known;
	}

	/** Reports the open documents of a repository whose Index entry changed behind VS Code's back. */
	async refresh(repository: Repository): Promise<void> {
		const documents = vscode.workspace.textDocuments.filter(document =>
			document.uri.scheme === INDEX_SCHEME && repository.relativePath(document.uri) !== undefined);
		const events: vscode.FileChangeEvent[] = [];
		for (const { uri } of documents) {
			const { entry } = await this.locate(uri);
			if (this.track(uri, entry?.oid).changed) {
				events.push({ type: vscode.FileChangeType.Changed, uri });
			}
		}
		if (events.length) {
			this.didChangeFile.fire(events);
		}
	}

	/** Makes open documents reload, e.g. to pick up the read-only state that goes with the diff mode. */
	reloadOpenDocuments(): void {
		const events: vscode.FileChangeEvent[] = [];
		for (const { uri } of vscode.workspace.textDocuments.filter(document => document.uri.scheme === INDEX_SCHEME)) {
			const known = this.tracked.get(uri.toString());
			if (known) {
				known.mtime = Math.max(Date.now(), known.mtime + 1);
				events.push({ type: vscode.FileChangeType.Changed, uri });
			}
		}
		if (events.length) {
			this.didChangeFile.fire(events);
		}
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const { repository, entry } = await this.locate(uri);
		const readonly = isInlineDiff()
			|| entry?.mode === GITLINK_MODE
			|| (entry !== undefined && await this.isBinary(repository, entry.oid));
		return {
			type: vscode.FileType.File,
			ctime: 0,
			mtime: this.track(uri, entry?.oid).mtime,
			size: entry && entry.mode !== GITLINK_MODE ? await repository.git.blobSize(entry.oid) : 0,
			permissions: readonly ? vscode.FilePermission.Readonly : undefined
		};
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const { repository, entry } = await this.locate(uri);
		this.track(uri, entry?.oid);
		if (!entry) {
			return new Uint8Array();
		}
		if (entry.mode === GITLINK_MODE) {
			return Buffer.from(`Subproject commit ${entry.oid}\n`);
		}
		return repository.git.readBlob(entry.oid);
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
		if (isInlineDiff()) {
			throw vscode.FileSystemError.NoPermissions(vscode.l10n.t('The Index can be edited only in the side-by-side diff view.'));
		}
		const { repository, file, entry } = await this.locate(uri);
		if (entry && entry.mode !== GITLINK_MODE && await this.isBinary(repository, entry.oid)) {
			throw vscode.FileSystemError.NoPermissions(vscode.l10n.t('Binary files cannot be edited in the Index.'));
		}
		let oid: string;
		try {
			oid = await repository.git.writeIndexContent(file, content);
		} catch (error) {
			throw vscode.FileSystemError.Unavailable(error instanceof Error ? error.message : String(error));
		}
		this.track(uri, oid);
		this.didChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
		void repository.refresh().catch(() => undefined);
	}

	watch(): vscode.Disposable {
		return new vscode.Disposable(() => undefined); // changes are reported from refresh()
	}

	readDirectory(): [string, vscode.FileType][] {
		return [];
	}

	createDirectory(uri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	delete(uri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	rename(uri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions(uri);
	}
}

/** Always-empty, read-only files (`git-index-empty:`), shown in place of a deleted working tree file. */
export class EmptyFileSystem implements vscode.FileSystemProvider {
	readonly onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>().event;

	stat(): vscode.FileStat {
		return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0, permissions: vscode.FilePermission.Readonly };
	}

	readFile(): Uint8Array {
		return new Uint8Array();
	}

	watch(): vscode.Disposable {
		return new vscode.Disposable(() => undefined);
	}

	readDirectory(): [string, vscode.FileType][] {
		return [];
	}

	writeFile(uri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	createDirectory(uri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	delete(uri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	rename(uri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions(uri);
	}
}
