/*
 * The Repositories view's data, free of VS Code types so that it can be unit tested.
 */

export type RefKind = 'local' | 'remote' | 'tag';

export interface RefInfo {
	readonly kind: RefKind;
	/** As Git shows it: `main`, `origin/main`, `v1.0`. */
	readonly name: string;
	/** `refs/heads/main` and so on. */
	readonly fullName: string;
	readonly commit: string;
	/** For a remote-tracking branch, the remote and the branch name on it. */
	readonly remote?: string;
	readonly remoteBranch?: string;
	/** For a local branch with an upstream, its short name, e.g. `origin/main`. */
	readonly upstream?: string;
	readonly ahead?: number;
	readonly behind?: number;
	/** The upstream is configured but no longer exists. */
	readonly upstreamGone?: boolean;
	/** The branch is checked out. */
	readonly isHead: boolean;
	readonly subject: string;
}

/** The `git for-each-ref` format that parseRefs reads. Fields are separated by NUL. */
export const REF_FORMAT = ['%(refname)', '%(objectname)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(HEAD)', '%(subject)']
	.join('%00');

export const REF_PATTERNS = ['refs/heads', 'refs/remotes', 'refs/tags'];

function parseTrack(track: string): Pick<RefInfo, 'ahead' | 'behind' | 'upstreamGone'> {
	if (track === 'gone') {
		return { upstreamGone: true };
	}
	const ahead = /ahead (\d+)/.exec(track);
	const behind = /behind (\d+)/.exec(track);
	return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0 };
}

/** Parses `git for-each-ref --format=REF_FORMAT`. Skips the symbolic `refs/remotes/<remote>/HEAD`. */
export function parseRefs(output: string, remoteNames: readonly string[]): RefInfo[] {
	const refs: RefInfo[] = [];
	// longest remote names first, so that `origin/x` and `origin` are told apart
	const remotes = [...remoteNames].sort((a, b) => b.length - a.length);
	for (const line of output.split('\n')) {
		const [fullName, commit, upstream, track, head, ...subject] = line.replace(/\r$/, '').split('\0');
		if (!fullName || !commit) {
			continue;
		}
		const base = { fullName, commit, isHead: head === '*', subject: subject.join('\0') };
		if (fullName.startsWith('refs/heads/')) {
			refs.push({
				...base,
				kind: 'local',
				name: fullName.slice('refs/heads/'.length),
				upstream: upstream || undefined,
				...(upstream ? parseTrack(track) : {})
			});
		} else if (fullName.startsWith('refs/remotes/')) {
			const name = fullName.slice('refs/remotes/'.length);
			const remote = remotes.find(candidate => name.startsWith(`${candidate}/`)) ?? name.split('/')[0];
			const remoteBranch = name.slice(remote.length + 1);
			if (remoteBranch === 'HEAD') {
				continue;
			}
			refs.push({ ...base, kind: 'remote', name, remote, remoteBranch });
		} else if (fullName.startsWith('refs/tags/')) {
			refs.push({ ...base, kind: 'tag', name: fullName.slice('refs/tags/'.length) });
		}
	}
	return refs;
}

export interface RemoteInfo {
	readonly name: string;
	readonly url: string;
	readonly pushUrls: string[];
	readonly fetch: string[];
	readonly push: string[];
	/** `--tags`, `--no-tags`, or empty for Git's default (follow tags). */
	readonly tagOpt: string;
	/** `true`, `false`, or empty for the global `fetch.prune`. */
	readonly prune: string;
}

/** Parses `git config -z --get-regexp ^remote\.`: records `key\nvalue\0`, keys lowercased except the remote name. */
export function parseRemoteConfig(output: string): RemoteInfo[] {
	const remotes = new Map<string, { -readonly [K in keyof RemoteInfo]: RemoteInfo[K] }>();
	for (const record of output.split('\0')) {
		const newline = record.indexOf('\n');
		const key = newline >= 0 ? record.slice(0, newline) : record;
		const value = newline >= 0 ? record.slice(newline + 1) : '';
		const lastDot = key.lastIndexOf('.');
		if (!key.startsWith('remote.') || lastDot <= 'remote.'.length) {
			continue;
		}
		const name = key.slice('remote.'.length, lastDot);
		const variable = key.slice(lastDot + 1).toLowerCase();
		let remote = remotes.get(name);
		if (!remote) {
			remote = { name, url: '', pushUrls: [], fetch: [], push: [], tagOpt: '', prune: '' };
			remotes.set(name, remote);
		}
		switch (variable) {
			case 'url': remote.url = value; break;
			case 'pushurl': remote.pushUrls.push(value); break;
			case 'fetch': remote.fetch.push(value); break;
			case 'push': remote.push.push(value); break;
			case 'tagopt': remote.tagOpt = value; break;
			case 'prune': remote.prune = value; break;
		}
	}
	return [...remotes.values()].filter(remote => remote.url || remote.fetch.length);
}

/** Branches checked out recently, newest first, from reflog subjects like `checkout: moving from a to b`. */
export function recentBranches(reflogSubjects: readonly string[], existing: ReadonlySet<string>, limit = 10): string[] {
	const result: string[] = [];
	for (const subject of reflogSubjects) {
		const match = /^checkout: moving from (\S+) to (\S+)$/.exec(subject);
		if (!match) {
			continue;
		}
		for (const name of [match[2], match[1]]) {
			if (existing.has(name) && !result.includes(name)) {
				result.push(name);
			}
		}
		if (result.length >= limit) {
			break;
		}
	}
	return result.slice(0, limit);
}

export interface RefFolder {
	readonly type: 'folder';
	/** Path of the folder within the branch names, e.g. `feature` or `origin/feature`. */
	readonly path: string;
	readonly label: string;
	readonly children: RefTreeNode[];
}

export interface RefLeaf {
	readonly type: 'ref';
	readonly ref: RefInfo;
	/** The last segment in a hierarchical layout, else the whole name. */
	readonly label: string;
}

export type RefTreeNode = RefFolder | RefLeaf;

function compareNames(a: string, b: string): number {
	return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
}

/** Branches as a flat list, or grouped into folders at each `/` (EGit's hierarchical branch layout). */
export function buildRefTree(refs: readonly RefInfo[], hierarchical: boolean): RefTreeNode[] {
	const sorted = [...refs].sort((a, b) => compareNames(a.name, b.name));
	if (!hierarchical) {
		return sorted.map(ref => ({ type: 'ref', ref, label: ref.name }));
	}
	interface Folder { path: string; folders: Map<string, Folder>; leaves: RefLeaf[] }
	const root: Folder = { path: '', folders: new Map(), leaves: [] };
	for (const ref of sorted) {
		const parts = ref.name.split('/');
		let folder = root;
		for (const part of parts.slice(0, -1)) {
			let child = folder.folders.get(part);
			if (!child) {
				child = { path: folder.path ? `${folder.path}/${part}` : part, folders: new Map(), leaves: [] };
				folder.folders.set(part, child);
			}
			folder = child;
		}
		folder.leaves.push({ type: 'ref', ref, label: parts[parts.length - 1] });
	}
	const freeze = (folder: Folder): RefTreeNode[] => [
		...[...folder.folders.entries()]
			.sort(([a], [b]) => compareNames(a, b))
			.map(([name, child]): RefFolder => ({ type: 'folder', path: child.path, label: name, children: freeze(child) })),
		...folder.leaves
	];
	return freeze(root);
}

export interface RefChanges {
	readonly updated: string[];
	readonly created: string[];
	readonly deleted: string[];
}

/** What a fetch did to the refs, from snapshots of `refname -> commit`. */
export function diffRefs(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): RefChanges {
	const updated: string[] = [];
	const created: string[] = [];
	const deleted: string[] = [];
	for (const [name, commit] of after) {
		const previous = before.get(name);
		if (previous === undefined) {
			created.push(name);
		} else if (previous !== commit) {
			updated.push(name);
		}
	}
	for (const name of before.keys()) {
		if (!after.has(name)) {
			deleted.push(name);
		}
	}
	return { updated, created, deleted };
}

/** Parses `refname\0objectname` lines into a snapshot. */
export function parseRefSnapshot(output: string): Map<string, string> {
	const snapshot = new Map<string, string>();
	for (const line of output.split('\n')) {
		const [name, commit] = line.replace(/\r$/, '').split('\0');
		if (name && commit) {
			snapshot.set(name, commit);
		}
	}
	return snapshot;
}

/** The name EGit suggests for a branch created from a ref: the remote branch's name, or `<tag>-branch`. */
export function suggestBranchName(ref: Pick<RefInfo, 'kind' | 'name' | 'remoteBranch'> | undefined): string {
	if (!ref) {
		return '';
	}
	switch (ref.kind) {
		case 'remote': return ref.remoteBranch ?? ref.name;
		case 'tag': return `${ref.name}-branch`;
		case 'local': return '';
	}
}

/** Splits refspecs typed on one line or several. */
export function splitRefspecs(text: string): string[] {
	return text.split(/\s+/).map(spec => spec.trim()).filter(Boolean);
}

/**
 * Whether a refspec looks valid: `[+]<src>[:<dst>]` without spaces and with at most one colon,
 * `[+]:<dst>` (delete on push), or `:` (push matching branches).
 */
export function isRefspec(spec: string): boolean {
	return spec === ':' || spec === '+:'
		|| /^\+?[^\s:+][^\s:]*(:[^\s:]*)?$/.test(spec)
		|| /^\+?:[^\s:]+$/.test(spec);
}
