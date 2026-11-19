/*
 * The part of the built-in Git extension's API (`vscode.git`, `getAPI(1)`) that this extension uses.
 * Copied from microsoft/vscode extensions/git/src/api/git.d.ts; the enum values were checked against
 * the shipped extension.
 */
import { Event, Uri } from 'vscode';

export interface Git {
	readonly path: string;
}

export const enum RefType {
	Head,
	RemoteHead,
	Tag
}

export interface Ref {
	readonly type: RefType;
	readonly name?: string;
	readonly commit?: string;
	readonly remote?: string;
}

export interface UpstreamRef {
	readonly remote: string;
	readonly name: string;
	readonly commit?: string;
}

export interface Branch extends Ref {
	readonly upstream?: UpstreamRef;
	readonly ahead?: number;
	readonly behind?: number;
}

export interface Remote {
	readonly name: string;
	readonly fetchUrl?: string;
	readonly pushUrl?: string;
	readonly isReadOnly: boolean;
}

export const enum Status {
	INDEX_MODIFIED,
	INDEX_ADDED,
	INDEX_DELETED,
	INDEX_RENAMED,
	INDEX_COPIED,

	MODIFIED,
	DELETED,
	UNTRACKED,
	IGNORED,
	INTENT_TO_ADD,
	INTENT_TO_RENAME,
	TYPE_CHANGED,

	ADDED_BY_US,
	ADDED_BY_THEM,
	DELETED_BY_US,
	DELETED_BY_THEM,
	BOTH_ADDED,
	BOTH_DELETED,
	BOTH_MODIFIED
}

export interface Change {
	/** For renames, the new path. */
	readonly uri: Uri;
	readonly originalUri: Uri;
	readonly renameUri: Uri | undefined;
	readonly status: Status;
}

export interface RepositoryState {
	readonly HEAD: Branch | undefined;
	readonly refs: Ref[];
	readonly remotes: Remote[];
	readonly mergeChanges: Change[];
	readonly indexChanges: Change[];
	readonly workingTreeChanges: Change[];
	readonly untrackedChanges: Change[];
	readonly onDidChange: Event<void>;
}

export interface RepositoryUIState {
	/** Whether the repository is selected in the Source Control view. */
	readonly selected: boolean;
	readonly onDidChange: Event<void>;
}

export const enum ForcePushMode {
	Force,
	ForceWithLease,
	ForceWithLeaseIfIncludes
}

export interface FetchOptions {
	/** A remote name, or a URL. */
	remote?: string;
	ref?: string;
	all?: boolean;
	prune?: boolean;
	depth?: number;
}

export interface Repository {
	readonly rootUri: Uri;
	readonly state: RepositoryState;
	readonly ui: RepositoryUIState;
	status(): Promise<void>;
	fetch(options?: FetchOptions): Promise<void>;
	pull(unshallow?: boolean): Promise<void>;
	/** `branchName` is passed to git push as it is, so it can be any refspec. */
	push(remoteName?: string, branchName?: string, setUpstream?: boolean, force?: ForcePushMode): Promise<void>;
}

export type APIState = 'uninitialized' | 'initialized';

export interface API {
	readonly state: APIState;
	readonly onDidChangeState: Event<APIState>;
	readonly git: Git;
	readonly repositories: Repository[];
	readonly onDidOpenRepository: Event<Repository>;
	readonly onDidCloseRepository: Event<Repository>;
	toGitUri(uri: Uri, ref: string): Uri;
	getRepository(uri: Uri): Repository | null;
}

export interface GitExtension {
	readonly enabled: boolean;
	readonly onDidChangeEnablement: Event<boolean>;
	getAPI(version: 1): API;
}
