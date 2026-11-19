import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

export class GitError extends Error {
	constructor(message: string, readonly exitCode: number | null, readonly stdout: Buffer = Buffer.alloc(0)) {
		super(message);
	}
}

export interface TreeEntry {
	readonly mode: string;
	readonly oid: string;
}

/** A git operation that is waiting for the user, read from the files Git keeps in its directory. */
export type Operation = 'none' | 'merge' | 'rebase' | 'cherryPick' | 'revert';

export interface CommitOptions {
	readonly message: string;
	readonly amend: boolean;
	readonly signOff: boolean;
	/** `Name <email>`; omitted to let Git use its configured identity. */
	readonly author?: string;
	readonly committer?: string;
}

interface RunOptions {
	readonly input?: Uint8Array | string;
	readonly env?: Readonly<Record<string, string>>;
}

const LOCK_RETRIES = 6;

/**
 * Failures to replace a file in .git (index, HEAD, a ref, config) because another process has it
 * open. On Windows that happens while the built-in Git extension reads the file, and retrying shortly
 * after succeeds. Git takes such files with a lock file and renames it at the end, so nothing changed.
 */
const BUSY_FILE = /index\.lock|unable to write symref|could not write config file|cannot lock ref|Unable to create '.*\.lock'|Permission denied/i;

/** The submodule mode in trees and in the Index. */
export const GITLINK_MODE = '160000';
export const SYMLINK_MODE = '120000';

function pathspecInput(paths: readonly string[]): string {
	return paths.join('\0') + '\0';
}

const PATHSPEC_FROM_STDIN = ['--pathspec-from-file=-', '--pathspec-file-nul'];

/** Splits `Name <email>` into its parts. */
export function parseIdent(ident: string): { name: string; email: string } | undefined {
	const match = /^\s*(.*?)\s*<([^<>]*)>\s*$/.exec(ident);
	return match && match[1] ? { name: match[1], email: match[2] } : undefined;
}

export class GitRepository {
	private queue: Promise<unknown> = Promise.resolve();

	private constructor(
		private readonly binary: () => string,
		readonly root: string,
		readonly gitDir: string,
		private readonly log: (message: string) => void
	) { }

	/** Finds the repository containing `folder`, keeping the spelling of `folder` in the root path. */
	static async open(binary: () => string, folder: string, log: (message: string) => void): Promise<GitRepository | undefined> {
		const probe = new GitRepository(binary, folder, '', log);
		try {
			const output = await probe.run(['rev-parse', '--show-cdup', '--absolute-git-dir']);
			const [cdup, gitDir] = output.toString('utf8').split(/\r?\n/);
			return new GitRepository(binary, path.resolve(folder, cdup), gitDir, log);
		} catch {
			return undefined;
		}
	}

	run(args: readonly string[], options: RunOptions = {}): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const child = spawn(this.binary(), ['--literal-pathspecs', ...args], {
				cwd: this.root,
				env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...options.env },
				windowsHide: true
			});
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			child.stdout.on('data', chunk => stdout.push(chunk));
			child.stderr.on('data', chunk => stderr.push(chunk));
			child.stdin.on('error', () => { /* git may exit before reading all of its input */ });
			child.on('error', error => reject(new GitError(error.message, null)));
			child.on('close', code => {
				if (code === 0) {
					resolve(Buffer.concat(stdout));
					return;
				}
				const message = Buffer.concat(stderr).toString('utf8').trim() || `git ${args[0]} exited with code ${code}`;
				reject(new GitError(message, code, Buffer.concat(stdout)));
			});
			child.stdin.end(options.input);
		});
	}

	/**
	 * Runs an operation that writes the Index. These are serialized so that two of ours
	 * never race for index.lock, and retried while some other git process holds it.
	 */
	private exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const attempt = async () => {
			for (let retry = 0; ; retry++) {
				try {
					return await operation();
				} catch (error) {
					if (retry >= LOCK_RETRIES || !(error instanceof GitError) || !BUSY_FILE.test(error.message)) {
						this.log(`git failed: ${error instanceof Error ? error.message : error}`);
						throw error;
					}
					await new Promise(resolve => setTimeout(resolve, 50 * 2 ** retry));
				}
			}
		};
		const result = this.queue.then(attempt, attempt);
		this.queue = result.catch(() => undefined);
		return result;
	}

	private async indexEntries(file: string): Promise<(TreeEntry & { stage: number })[]> {
		const output = await this.run(['ls-files', '--stage', '-z', '--', file]);
		const entries: (TreeEntry & { stage: number })[] = [];
		for (const line of output.toString('utf8').split('\0')) {
			const match = /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s.exec(line);
			if (match && match[4] === file) {
				entries.push({ mode: match[1], oid: match[2], stage: Number(match[3]) });
			}
		}
		return entries;
	}

	/** The merged (stage 0) Index entry of a file. */
	async indexEntry(file: string): Promise<TreeEntry | undefined> {
		return (await this.indexEntries(file)).find(entry => entry.stage === 0);
	}

	/** Whether the Index holds unmerged (conflict) stages for a file. */
	async isConflicted(file: string): Promise<boolean> {
		return (await this.indexEntries(file)).some(entry => entry.stage !== 0);
	}

	/** The entry of a file in the tree of `ref`, or undefined if the ref or the path does not exist. */
	async refEntry(ref: string, file: string): Promise<TreeEntry | undefined> {
		let output: Buffer;
		try {
			output = await this.run(['ls-tree', '-z', ref, '--', file]);
		} catch (error) {
			if (error instanceof GitError && error.exitCode !== null) {
				return undefined; // no such ref, e.g. no commit yet
			}
			throw error;
		}
		const match = /^(\d+) (?:blob|commit) ([0-9a-f]+)\t/.exec(output.toString('utf8'));
		return match ? { mode: match[1], oid: match[2] } : undefined;
	}

	headEntry(file: string): Promise<TreeEntry | undefined> {
		return this.refEntry('HEAD', file);
	}

	readBlob(oid: string): Promise<Buffer> {
		return this.run(['cat-file', 'blob', oid]);
	}

	async blobSize(oid: string): Promise<number> {
		return Number((await this.run(['cat-file', '-s', oid])).toString('utf8').trim());
	}

	/**
	 * Replaces the Index content of a file without touching the working tree. The bytes of a file
	 * already in the Index are stored as they are: what its Index side shows is the filtered form,
	 * so applying clean filters (autocrlf and the like) again would change it behind the user's
	 * back. Content for a new path comes from the working tree, so that one does get filtered.
	 */
	writeIndexContent(file: string, content: Uint8Array): Promise<string> {
		return this.exclusive(async () => {
			const entries = await this.indexEntries(file);
			if (entries.some(entry => entry.stage !== 0)) {
				throw new GitError(`${file} has unresolved merge conflicts; resolve it in the working tree and stage it.`, null);
			}
			const mode = entries[0]?.mode ?? (await this.headEntry(file))?.mode ?? await this.workingTreeMode(file);
			if (mode === GITLINK_MODE) {
				throw new GitError(`${file} is a submodule; its Index entry cannot be edited as text.`, null);
			}
			const filters = entries.length ? '--no-filters' : `--path=${file}`;
			const output = await this.run(['hash-object', '-w', filters, '--stdin'], { input: content });
			const oid = output.toString('utf8').trim();
			await this.run(['update-index', '--add', '--cacheinfo', `${mode},${oid},${file}`]);
			return oid;
		});
	}

	/** Makes the Index entry of a file equal to its entry in `ref`, removing it if `ref` lacks the path. */
	resetIndexTo(ref: string, file: string): Promise<unknown> {
		return this.exclusive(async () => {
			const entry = await this.refEntry(ref, file);
			if (entry) {
				return this.run(['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.oid},${file}`]);
			}
			return this.run(['update-index', '--force-remove', '--', file]);
		});
	}

	private async workingTreeMode(file: string): Promise<string> {
		try {
			const stat = await fs.stat(path.join(this.root, file));
			return process.platform !== 'win32' && stat.mode & 0o100 ? '100755' : '100644';
		} catch {
			return '100644';
		}
	}

	stage(paths: readonly string[]): Promise<unknown> {
		return this.exclusive(() => this.run(['add', '--all', ...PATHSPEC_FROM_STDIN], { input: pathspecInput(paths) }));
	}

	stageAll(): Promise<unknown> {
		return this.exclusive(() => this.run(['add', '--all']));
	}

	unstage(paths: readonly string[]): Promise<unknown> {
		return this.exclusive(() => this.run(['reset', '-q', ...PATHSPEC_FROM_STDIN], { input: pathspecInput(paths) }));
	}

	unstageAll(): Promise<unknown> {
		return this.exclusive(() => this.run(['reset', '-q']));
	}

	/** Makes the working tree copy of tracked files match the Index. */
	restoreFromIndex(paths: readonly string[]): Promise<unknown> {
		return this.exclusive(() => this.run(['restore', ...PATHSPEC_FROM_STDIN], { input: pathspecInput(paths) }));
	}

	/**
	 * Makes both the Index and the working tree match `source`. A tracked path that `source`
	 * lacks is removed from both.
	 */
	restoreFromSource(source: string, paths: readonly string[]): Promise<unknown> {
		return this.exclusive(() => this.run(
			['restore', `--source=${source}`, '--staged', '--worktree', ...PATHSPEC_FROM_STDIN],
			{ input: pathspecInput(paths) }
		));
	}

	/**
	 * Resolves conflicts by taking one side. A path that side deleted is removed and the deletion
	 * staged; otherwise the working tree gets that side's content and the conflict stays until
	 * the file is added to the Index.
	 */
	takeConflictSide(side: 'ours' | 'theirs', paths: readonly string[]): Promise<unknown> {
		return this.exclusive(async () => {
			for (const file of paths) {
				try {
					await this.run(['checkout', `--${side}`, '--', file]);
				} catch (error) {
					if (!(error instanceof GitError) || !/does not have (our|their) version/.test(error.message)) {
						throw error;
					}
					await this.run(['rm', '-q', '--', file]);
				}
			}
		});
	}

	setAssumeUnchanged(paths: readonly string[], assumeUnchanged: boolean): Promise<unknown> {
		const flag = assumeUnchanged ? '--assume-unchanged' : '--no-assume-unchanged';
		return this.exclusive(() => this.run(['update-index', flag, '-z', '--stdin'], { input: pathspecInput(paths) }));
	}

	/** Paths marked assume-unchanged (`git ls-files -v` reports them with a lowercase tag). */
	async assumeUnchangedFiles(): Promise<string[]> {
		const output = await this.run(['ls-files', '-v', '-z']);
		return output.toString('utf8').split('\0')
			.filter(line => /^[a-z] /.test(line))
			.map(line => line.slice(2));
	}

	/** Removes paths from the Index but keeps them in the working tree (`git rm --cached`). */
	untrack(paths: readonly string[]): Promise<unknown> {
		return this.exclusive(() => this.run(['rm', '--cached', '-r', '-q', '--', ...paths]));
	}

	/** A configuration value, or undefined if it is not set. */
	async config(key: string): Promise<string | undefined> {
		try {
			return (await this.run(['config', '--get', key])).toString('utf8').replace(/\r?\n$/, '');
		} catch (error) {
			if (error instanceof GitError && error.exitCode === 1) {
				return undefined;
			}
			throw error;
		}
	}

	/** The configured `Name <email>`, or undefined when either part is missing. */
	async userIdent(): Promise<string | undefined> {
		const [name, email] = await Promise.all([this.config('user.name'), this.config('user.email')]);
		return name && email ? `${name} <${email}>` : undefined;
	}

	/** The full message of the HEAD commit, or undefined before the first commit. */
	async headMessage(): Promise<string | undefined> {
		try {
			return (await this.run(['log', '-1', '--format=%B'])).toString('utf8').replace(/\s+$/, '');
		} catch {
			return undefined;
		}
	}

	/** Whether some remote-tracking branch already contains HEAD, so amending would rewrite published history. */
	async isHeadPublished(): Promise<boolean> {
		try {
			const output = await this.run(['for-each-ref', '--count=1', '--contains=HEAD', '--format=%(refname)', 'refs/remotes']);
			return output.toString('utf8').trim().length > 0;
		} catch {
			return false;
		}
	}

	private async exists(relative: string): Promise<boolean> {
		try {
			await fs.stat(path.join(this.gitDir, relative));
			return true;
		} catch {
			return false;
		}
	}

	async operation(): Promise<Operation> {
		if (await this.exists('rebase-merge') || await this.exists('rebase-apply')) {
			return 'rebase';
		}
		if (await this.exists('MERGE_HEAD')) {
			return 'merge';
		}
		if (await this.exists('CHERRY_PICK_HEAD')) {
			return 'cherryPick';
		}
		if (await this.exists('REVERT_HEAD')) {
			return 'revert';
		}
		return 'none';
	}

	/** The message Git prepared for a merge, cherry-pick or revert commit. */
	async preparedMessage(): Promise<string | undefined> {
		try {
			return await fs.readFile(path.join(this.gitDir, 'MERGE_MSG'), 'utf8');
		} catch {
			return undefined;
		}
	}

	/** The content of the `commit.template` file, if one is configured and readable. */
	async commitTemplate(): Promise<string | undefined> {
		const configured = await this.config('commit.template');
		if (!configured) {
			return undefined;
		}
		const expanded = configured.startsWith('~') ? path.join(os.homedir(), configured.slice(1)) : configured;
		try {
			return await fs.readFile(path.resolve(this.root, expanded), 'utf8');
		} catch {
			return undefined;
		}
	}

	commit(options: CommitOptions): Promise<unknown> {
		const args = ['commit'];
		if (options.amend) {
			args.push('--amend');
		}
		if (options.signOff) {
			args.push('--signoff');
		}
		if (options.author) {
			args.push(`--author=${options.author}`);
		}
		if (!options.message && options.amend) {
			args.push('--no-edit');
		} else {
			args.push('--file=-');
		}
		const committer = options.committer ? parseIdent(options.committer) : undefined;
		const env = committer ? { GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email } : undefined;
		return this.exclusive(() => this.run(args, { input: options.message, env }));
	}

	/** Runs a command that changes the Index or HEAD (checkout, merge, branch...), serialized with Index writes. */
	mutate(args: readonly string[], options: RunOptions = {}): Promise<Buffer> {
		return this.exclusive(() => this.run(args, options));
	}

	/** Output of `git for-each-ref` with a format, empty in a repository without refs. */
	async forEachRef(format: string, patterns: readonly string[]): Promise<string> {
		return (await this.run(['for-each-ref', `--format=${format}`, ...patterns])).toString('utf8');
	}

	/** `git config -z --get-regexp`, or an empty string when nothing matches. */
	async configRegexp(pattern: string): Promise<string> {
		try {
			return (await this.run(['config', '-z', '--get-regexp', pattern])).toString('utf8');
		} catch (error) {
			if (error instanceof GitError && error.exitCode === 1) {
				return '';
			}
			throw error;
		}
	}

	/** Sets a configuration value, or removes every value of the key when `value` is undefined. */
	async setConfig(key: string, value: string | undefined): Promise<void> {
		if (value === undefined) {
			await this.unsetConfig(key);
		} else {
			await this.run(['config', key, value]);
		}
	}

	/** Replaces all values of a multi-valued key. */
	async setConfigValues(key: string, values: readonly string[]): Promise<void> {
		await this.unsetConfig(key);
		for (const value of values) {
			await this.run(['config', '--add', key, value]);
		}
	}

	private async unsetConfig(key: string): Promise<void> {
		try {
			await this.run(['config', '--unset-all', key]);
		} catch (error) {
			if (!(error instanceof GitError) || error.exitCode !== 5) {
				throw error; // 5: the key is not set
			}
		}
	}

	/** The commit a ref points to, or undefined if it does not resolve. */
	async resolveCommit(ref: string): Promise<string | undefined> {
		try {
			return (await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).toString('utf8').trim() || undefined;
		} catch {
			return undefined;
		}
	}

	/** The subjects of the HEAD reflog, newest first; empty before the first commit. */
	async reflogSubjects(limit: number): Promise<string[]> {
		try {
			return (await this.run(['reflog', `-n${limit}`, '--format=%gs', 'HEAD'])).toString('utf8').split(/\r?\n/).filter(Boolean);
		} catch {
			return [];
		}
	}

	/** Whether Git accepts a name for a new branch. */
	async isValidBranchName(name: string): Promise<boolean> {
		try {
			await this.run(['check-ref-format', '--branch', name]);
			return true;
		} catch {
			return false;
		}
	}

	rebaseContinue(): Promise<unknown> {
		// GIT_EDITOR=true keeps the message of the commit being replayed
		return this.exclusive(() => this.run(['rebase', '--continue'], { env: { GIT_EDITOR: 'true' } }));
	}

	rebaseAbort(): Promise<unknown> {
		return this.exclusive(() => this.run(['rebase', '--abort']));
	}

	mergeAbort(): Promise<unknown> {
		return this.exclusive(() => this.run(['merge', '--abort']));
	}
}
