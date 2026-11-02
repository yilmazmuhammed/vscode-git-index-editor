import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';

export class GitError extends Error {
	constructor(message: string, readonly exitCode: number | null) {
		super(message);
	}
}

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'typeChanged' | 'untracked';

export interface StatusEntry {
	/** Path relative to the repository root, with forward slashes. */
	readonly path: string;
	/** Change between HEAD and the Index, if any. */
	readonly staged?: ChangeKind;
	/** Change between the Index and the working tree, if any. */
	readonly unstaged?: ChangeKind;
	readonly conflicted: boolean;
	readonly submodule: boolean;
}

export interface TreeEntry {
	readonly mode: string;
	readonly oid: string;
}

interface RunOptions {
	readonly input?: Uint8Array | string;
}

const LOCK_RETRIES = 6;

function changeKind(code: string): ChangeKind | undefined {
	switch (code) {
		case 'M': return 'modified';
		case 'A': return 'added';
		case 'D': return 'deleted';
		case 'T': return 'typeChanged';
		default: return undefined;
	}
}

/** Parses `git status --porcelain=v2 -z --no-renames`. */
export function parseStatus(output: string): StatusEntry[] {
	const entries: StatusEntry[] = [];
	for (const field of output.split('\0')) {
		const parts = field.split(' ');
		switch (field[0]) {
			case '?':
				entries.push({ path: field.slice(2), unstaged: 'untracked', conflicted: false, submodule: false });
				break;
			case '1':
				entries.push({
					path: parts.slice(8).join(' '),
					staged: changeKind(parts[1][0]),
					unstaged: changeKind(parts[1][1]),
					conflicted: false,
					submodule: parts[2][0] === 'S'
				});
				break;
			case 'u':
				entries.push({
					path: parts.slice(10).join(' '),
					conflicted: true,
					submodule: parts[2][0] === 'S'
				});
				break;
		}
	}
	return entries;
}

function pathspecInput(paths: readonly string[]): string {
	return paths.join('\0') + '\0';
}

const PATHSPEC_FROM_STDIN = ['--pathspec-from-file=-', '--pathspec-file-nul'];

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
				env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
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
				reject(new GitError(message, code));
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
					if (retry >= LOCK_RETRIES || !(error instanceof GitError) || !error.message.includes('index.lock')) {
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

	async status(): Promise<StatusEntry[]> {
		const output = await this.run(['status', '--porcelain=v2', '-z', '--no-renames', '--untracked-files=all']);
		return parseStatus(output.toString('utf8'));
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

	async headEntry(file: string): Promise<TreeEntry | undefined> {
		let output: Buffer;
		try {
			output = await this.run(['ls-tree', '-z', 'HEAD', '--', file]);
		} catch (error) {
			if (error instanceof GitError && error.exitCode !== null) {
				return undefined; // no commit yet
			}
			throw error;
		}
		const match = /^(\d+) blob ([0-9a-f]+)\t/.exec(output.toString('utf8'));
		return match ? { mode: match[1], oid: match[2] } : undefined;
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
			const filters = entries.length ? '--no-filters' : `--path=${file}`;
			const output = await this.run(['hash-object', '-w', filters, '--stdin'], { input: content });
			const oid = output.toString('utf8').trim();
			await this.run(['update-index', '--add', '--cacheinfo', `${mode},${oid},${file}`]);
			return oid;
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

	commit(message: string, amend: boolean): Promise<unknown> {
		const args = ['commit'];
		if (amend) {
			args.push('--amend');
		}
		if (!message && amend) {
			args.push('--no-edit');
		} else {
			args.push('--file=-');
		}
		return this.exclusive(() => this.run(args, { input: message }));
	}
}
