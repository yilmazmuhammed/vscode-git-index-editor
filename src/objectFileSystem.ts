import * as vscode from 'vscode';
import { isInlineDiff } from './diffMode';
import { Repository, RepositoryManager } from './repository';
import { HEAD_SCHEME, INDEX_SCHEME, isEmptyUri } from './uris';

interface Tracked {
	oid: string | undefined;
	mtime: number;
}

/**
 * Exposes the Index (`git-index:`, writable) or HEAD (`git-head:`, read-only) as files, so the
 * regular text editors and diff editors work on them. A path missing from the Index or HEAD
 * reads as an empty file: that is what the diff should show, and saving such an Index document
 * adds the file to the Index.
 */
export class ObjectFileSystem implements vscode.FileSystemProvider {
	private readonly didChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.didChangeFile.event;

	/**
	 * Blobs have no timestamps, but VS Code needs mtime to grow when a file changes: that is how
	 * it decides to reload a document and detects saving over a newer version.
	 */
	private readonly tracked = new Map<string, Tracked>();

	constructor(private readonly manager: RepositoryManager, private readonly scheme: typeof INDEX_SCHEME | typeof HEAD_SCHEME) { }

	private async locate(uri: vscode.Uri): Promise<{ repository: Repository; file: string; oid: string | undefined }> {
		const repository = await this.manager.repositoryFor(uri);
		const file = repository?.relativePath(uri);
		if (!repository || file === undefined) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		const entry = this.scheme === INDEX_SCHEME
			? await repository.git.indexEntry(file)
			: await repository.git.headEntry(file);
		return { repository, file, oid: entry?.oid };
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

	/** Reports the open documents of a repository whose object changed behind VS Code's back. */
	async refresh(repository: Repository): Promise<void> {
		const documents = vscode.workspace.textDocuments.filter(document =>
			document.uri.scheme === this.scheme && !isEmptyUri(document.uri) && repository.relativePath(document.uri) !== undefined);
		const events: vscode.FileChangeEvent[] = [];
		for (const { uri } of documents) {
			const { oid } = await this.locate(uri);
			if (this.track(uri, oid).changed) {
				events.push({ type: vscode.FileChangeType.Changed, uri });
			}
		}
		if (events.length) {
			this.didChangeFile.fire(events);
		}
	}

	/** Makes open documents pick up the read-only state that goes with the diff mode. */
	reloadOpenDocuments(): void {
		const events: vscode.FileChangeEvent[] = [];
		for (const { uri } of vscode.workspace.textDocuments.filter(document => document.uri.scheme === this.scheme)) {
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
		if (isEmptyUri(uri)) {
			return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 };
		}
		const { repository, oid } = await this.locate(uri);
		return {
			type: vscode.FileType.File,
			ctime: 0,
			mtime: this.track(uri, oid).mtime,
			size: oid ? await repository.git.blobSize(oid) : 0,
			permissions: isInlineDiff() ? vscode.FilePermission.Readonly : undefined
		};
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		if (isEmptyUri(uri)) {
			return new Uint8Array();
		}
		const { repository, oid } = await this.locate(uri);
		this.track(uri, oid);
		return oid ? repository.git.readBlob(oid) : new Uint8Array();
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
		if (this.scheme !== INDEX_SCHEME) {
			throw vscode.FileSystemError.NoPermissions(uri);
		}
		if (isInlineDiff()) {
			throw vscode.FileSystemError.NoPermissions('The Index can be edited only in the side-by-side diff view.');
		}
		const { repository, file } = await this.locate(uri);
		let oid: string;
		try {
			oid = await repository.git.writeIndexContent(file, content);
		} catch (error) {
			throw vscode.FileSystemError.Unavailable(error instanceof Error ? error.message : String(error));
		}
		this.track(uri, oid);
		this.didChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
		repository.scheduleRefresh();
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
