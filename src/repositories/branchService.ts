import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitError } from '../git';
import { Repository } from '../repository';
import { parseRefs, parseRemoteConfig, recentBranches, REF_FORMAT, REF_PATTERNS, RefInfo, RemoteInfo } from './model';

export type PullMode = 'merge' | 'rebase';

/**
 * What to do when local changes stop a checkout: ask; Smart Checkout (carry them over, or stay put if
 * they would conflict); stop so that they can be committed first; throw them away; or fail.
 */
export type DirtyCheckout = 'ask' | 'smart' | 'commit' | 'force' | 'fail';

const DIRTY = /would be overwritten by (checkout|switch)|commit your changes or stash them|untracked working tree files would be/i;

/** Holds the local changes while Smart Checkout runs; left behind only if going back fails. */
const SMART_CHECKOUT_REF = 'refs/git-index-editor/smart-checkout';

export async function readRemotes(repository: Repository): Promise<RemoteInfo[]> {
	return parseRemoteConfig(await repository.git.configRegexp('^remote\\.'));
}

export async function readRefs(repository: Repository): Promise<RefInfo[]> {
	const remotes = await readRemotes(repository);
	return parseRefs(await repository.git.forEachRef(REF_FORMAT, REF_PATTERNS), remotes.map(remote => remote.name));
}

export interface Upstream {
	/** A remote name, or `.` for a local branch. */
	readonly remote: string;
	/** The branch name on that remote. */
	readonly branch: string;
	readonly mode: PullMode;
}

export interface NewBranch {
	readonly name: string;
	/** Branch, tag, remote-tracking branch or commit to start from. */
	readonly start: string;
	/** For a start that is a remote-tracking branch: track it, pulling with this mode. */
	readonly upstreamMode?: PullMode;
	readonly checkout: boolean;
}

/** Branch operations of the Repositories view, without user interface so that they can be tested. */
export class BranchService {
	constructor(private readonly log: vscode.LogOutputChannel) { }

	/** Checks out a local branch, or a commit as a detached HEAD. Resolves false if the user cancels. */
	async checkout(repository: Repository, target: string, options: { detach?: boolean; onDirty?: DirtyCheckout } = {}): Promise<boolean> {
		const args = options.detach ? ['switch', '--detach', target] : ['switch', target];
		return this.switch(repository, args, target, options.onDirty ?? 'ask');
	}

	/** Checks out a remote-tracking branch: its local branch if there is one, else a new one that tracks it. */
	async checkoutRemote(repository: Repository, ref: RefInfo, onDirty: DirtyCheckout = 'ask'): Promise<boolean> {
		const local = ref.remoteBranch ?? ref.name;
		if (await repository.git.resolveCommit(`refs/heads/${local}`) === undefined) {
			// created first, so that the switch can be retried if HEAD is busy
			await repository.git.run(['branch', '--track', local, ref.name]);
		}
		return this.switch(repository, ['switch', local], local, onDirty);
	}

	private async switch(repository: Repository, args: string[], target: string, onDirty: DirtyCheckout): Promise<boolean> {
		try {
			await repository.git.mutate(args);
			return true;
		} catch (error) {
			if (!(error instanceof GitError) || !DIRTY.test(error.message) || onDirty === 'fail') {
				throw error;
			}
			const choice = onDirty === 'ask' ? await this.askAboutLocalChanges(target, error.message) : onDirty;
			switch (choice) {
				case 'smart':
					return this.smartCheckout(repository, args, target);
				case 'force':
					await repository.git.mutate([args[0], '--discard-changes', ...args.slice(1)]);
					return true;
				case 'commit':
					await vscode.commands.executeCommand('indexEditor.focusCommit');
					vscode.window.showInformationMessage(vscode.l10n.t('Commit your changes in the Git Staging view, then check out {0} again.', target));
					return false;
				default:
					return false;
			}
		} finally {
			await repository.refresh().catch(() => undefined);
		}
	}

	private async askAboutLocalChanges(target: string, gitMessage: string): Promise<DirtyCheckout> {
		const smart = vscode.l10n.t('Smart Checkout');
		const commit = vscode.l10n.t('Commit First…');
		const discard = vscode.l10n.t('Discard Changes and Check Out');
		const answer = await vscode.window.showWarningMessage(
			vscode.l10n.t('Local changes would be overwritten by checking out {0}.', target),
			{
				modal: true,
				detail: `${vscode.l10n.t('Smart Checkout takes your changes, staged and unstaged, over to {0}. If they would conflict with {0}, nothing changes and you stay on the current branch.', target)}\n\n${gitMessage}`
			},
			smart, commit, discard);
		return answer === smart ? 'smart' : answer === commit ? 'commit' : answer === discard ? 'force' : 'fail';
	}

	/**
	 * Smart Checkout, all or nothing. Records the Index and the working tree (untracked files too) as
	 * commits, under a ref so that they cannot get lost, and merges both onto the target without touching
	 * anything. If either merge has conflicts, nothing has changed and the user stays where they are.
	 * Otherwise switches and writes the merged trees. Every step can be repeated, so the retries that
	 * busy files on Windows need are safe, and a failure goes back to the starting point exactly.
	 */
	private async smartCheckout(repository: Repository, args: string[], target: string): Promise<boolean> {
		const git = repository.git;
		const targetCommit = await git.resolveCommit(args[args.length - 1]);
		const head = await git.resolveCommit('HEAD');
		if (!targetCommit || !head) {
			throw new Error(vscode.l10n.t('{0} does not exist.', target));
		}
		const branch = (await git.run(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => Buffer.alloc(0))).toString('utf8').trim();

		let indexTree: string;
		try {
			indexTree = (await git.run(['write-tree'])).toString('utf8').trim();
		} catch {
			throw new Error(vscode.l10n.t('Smart Checkout is not possible while there are unresolved conflicts.'));
		}
		const worktreeTree = await this.workingTreeTree(repository);
		const commitTree = async (tree: string, message: string) =>
			(await git.run(['commit-tree', tree, '-p', head, '-m', message])).toString('utf8').trim();
		const index = await commitTree(indexTree, `Git Index Editor: Index before Smart Checkout of ${target}`);
		const worktree = await commitTree(worktreeTree, `Git Index Editor: working tree before Smart Checkout of ${target}\n\nIndex: ${index}`);
		await git.run(['update-ref', '-m', `Smart Checkout of ${target}`, SMART_CHECKOUT_REF, worktree]);
		this.log.info(`Smart Checkout of ${target}: local changes saved as ${worktree} (Index ${index}) in ${SMART_CHECKOUT_REF}`);
		let keepRef = false;
		try {
			const mergedWorktree = await this.mergeOnto(repository, head, targetCommit, worktree);
			const mergedIndex = await this.mergeOnto(repository, head, targetCommit, index);
			const conflicts = [...new Set([...mergedWorktree.conflicts, ...mergedIndex.conflicts])];
			if (conflicts.length) {
				vscode.window.showWarningMessage(vscode.l10n.t('Smart Checkout of {0} was not done: your local changes conflict with it in {1}. You are still on the current branch, with your changes.',
					target, conflicts.slice(0, 5).join(', ') + (conflicts.length > 5 ? ', …' : '')));
				return false;
			}
			try {
				await git.mutate([args[0], '--discard-changes', ...args.slice(1)]);
				await git.mutate(['read-tree', '--reset', '-u', mergedWorktree.tree]);
				await git.mutate(['read-tree', mergedIndex.tree]);
			} catch (error) {
				this.log.error(`Smart Checkout of ${target}: ${error instanceof Error ? error.message : error}`);
				try {
					await git.mutate(branch ? ['switch', '--discard-changes', branch] : ['switch', '--discard-changes', '--detach', head]);
					await git.mutate(['read-tree', '--reset', '-u', worktree]);
					await git.mutate(['read-tree', index]);
				} catch (restoreError) {
					keepRef = true;
					throw new Error(vscode.l10n.t('Smart Checkout of {0} failed, and going back failed too. Your changes are saved in {1} (commit {2}).',
						target, SMART_CHECKOUT_REF, worktree) + ` ${restoreError instanceof Error ? restoreError.message : restoreError}`);
				}
				throw new Error(vscode.l10n.t('Smart Checkout of {0} failed, so you are back on the current branch with your changes: {1}', target,
					error instanceof Error ? error.message : String(error)));
			}
			return true;
		} finally {
			if (!keepRef) {
				await git.run(['update-ref', '-d', SMART_CHECKOUT_REF]).catch(() => undefined);
			}
			await git.run(['update-index', '-q', '--refresh']).catch(() => undefined);
		}
	}

	/** The working tree as a tree object, untracked files included and ignored ones not, without touching the Index. */
	private async workingTreeTree(repository: Repository): Promise<string> {
		const git = repository.git;
		const temporary = path.join(git.gitDir, `git-index-editor-${process.pid}-${Date.now()}.index`);
		try {
			// a copy of the Index, so that unchanged files are not hashed again
			await fs.copyFile(path.join(git.gitDir, 'index'), temporary).catch(() => undefined);
			const env = { GIT_INDEX_FILE: temporary };
			await git.run(['add', '--all'], { env });
			return (await git.run(['write-tree'], { env })).toString('utf8').trim();
		} finally {
			await fs.rm(temporary, { force: true });
		}
	}

	/** A three-way merge of `changes` onto `onto`, based on `base`, without touching the working tree or the Index. */
	private async mergeOnto(repository: Repository, base: string, onto: string, changes: string): Promise<{ tree: string; conflicts: string[] }> {
		const args = ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', `--merge-base=${base}`, onto, changes];
		try {
			const output = await repository.git.run(args);
			return { tree: output.toString('utf8').split('\0')[0].trim(), conflicts: [] };
		} catch (error) {
			if (error instanceof GitError && error.exitCode === 1) {
				// conflicts: the output is the tree, then the conflicted paths
				const [tree, ...paths] = error.stdout.toString('utf8').split('\0');
				return { tree: tree.trim(), conflicts: paths.filter(Boolean) };
			}
			if (error instanceof GitError && (error.exitCode === 128 || error.exitCode === 129)) {
				throw new Error(vscode.l10n.t('Smart Checkout needs Git 2.40 or later: {0}', error.message));
			}
			throw error;
		}
	}

	async createBranch(repository: Repository, branch: NewBranch, onDirty: DirtyCheckout = 'ask'): Promise<void> {
		const startIsRemote = (await repository.git.resolveCommit(`refs/remotes/${branch.start}`)) !== undefined;
		const track = startIsRemote ? [branch.upstreamMode ? '--track' : '--no-track'] : [];
		await repository.git.run(['branch', ...track, branch.name, branch.start]);
		if (startIsRemote && branch.upstreamMode === 'rebase') {
			await repository.git.setConfig(`branch.${branch.name}.rebase`, 'true');
		}
		if (branch.checkout) {
			await this.checkout(repository, branch.name, { onDirty });
		}
		await repository.refresh();
	}

	async renameBranch(repository: Repository, from: string, to: string): Promise<void> {
		await repository.git.run(['branch', '-m', from, to]);
		await repository.refresh();
	}

	/** Deletes branches; without force, ones with commits merged nowhere are left and reported. */
	async deleteBranches(repository: Repository, names: readonly string[], force: boolean): Promise<{ deleted: string[]; unmerged: string[] }> {
		const deleted: string[] = [];
		const unmerged: string[] = [];
		for (const name of names) {
			try {
				await repository.git.run(['branch', force ? '-D' : '-d', name]);
				deleted.push(name);
			} catch (error) {
				if (!force && error instanceof GitError && /not fully merged/.test(error.message)) {
					unmerged.push(name);
				} else {
					throw error;
				}
			}
		}
		await repository.refresh();
		return { deleted, unmerged };
	}

	/** Sets the upstream branch and pull mode of a branch (EGit's Configure Branch), or removes them. */
	async configureBranch(repository: Repository, name: string, upstream: Upstream | undefined): Promise<void> {
		if (upstream) {
			await repository.git.setConfig(`branch.${name}.remote`, upstream.remote);
			await repository.git.setConfig(`branch.${name}.merge`, `refs/heads/${upstream.branch}`);
			await repository.git.setConfig(`branch.${name}.rebase`, upstream.mode === 'rebase' ? 'true' : undefined);
		} else {
			await repository.git.setConfig(`branch.${name}.remote`, undefined);
			await repository.git.setConfig(`branch.${name}.merge`, undefined);
			await repository.git.setConfig(`branch.${name}.rebase`, undefined);
		}
		await repository.refresh();
	}

	/** The pull mode configured for a branch. */
	async pullMode(repository: Repository, name: string): Promise<PullMode> {
		const rebase = await repository.git.config(`branch.${name}.rebase`) ?? await repository.git.config('pull.rebase');
		return rebase && rebase !== 'false' ? 'rebase' : 'merge';
	}

	/** Local branches checked out recently, newest first. */
	async recent(repository: Repository, localBranches: readonly string[]): Promise<string[]> {
		return recentBranches(await repository.git.reflogSubjects(300), new Set(localBranches));
	}

	/** Checks out the same local branch in several repositories; reports the ones that failed. */
	async switchAll(repositories: readonly Repository[], name: string, onDirty: DirtyCheckout = 'ask'): Promise<{ repository: Repository; error: string }[]> {
		const failures: { repository: Repository; error: string }[] = [];
		for (const repository of repositories) {
			try {
				if (!await this.checkout(repository, name, { onDirty })) {
					failures.push({ repository, error: vscode.l10n.t('Cancelled') });
				}
			} catch (error) {
				failures.push({ repository, error: error instanceof Error ? error.message : String(error) });
			}
		}
		return failures;
	}
}
