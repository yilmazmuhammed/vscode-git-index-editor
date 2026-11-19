import * as vscode from 'vscode';
import { Repository } from '../repository';
import { ForcePushMode } from '../typings/git';
import { BranchService, PullMode } from './branchService';
import { diffRefs, parseRefSnapshot, RefChanges, RemoteInfo } from './model';

export interface PushBranch {
	readonly local: string;
	readonly remote: string;
	readonly remoteBranch: string;
	/** Configure the pushed branch as upstream, pulling with this mode. */
	readonly upstreamMode?: PullMode;
	/** Overwrite the remote branch, unless it moved since the last fetch (--force-with-lease). */
	readonly force: boolean;
}

export interface PullFrom {
	readonly remote: string;
	readonly branch: string;
	readonly mode: PullMode;
	/** Also make it the upstream of the current branch. */
	readonly setUpstream: boolean;
}

/** Quotes an argument for the integrated terminal; works in PowerShell, cmd and POSIX shells for these values. */
function quote(value: string): string {
	return /^[\w./:@+=~^-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Remote, fetch, pull and push operations. Network operations go through the built-in Git
 * extension's API, so they use VS Code's credential prompts and helpers.
 */
export class RemoteService {
	constructor(private readonly branches: BranchService, private readonly log: vscode.LogOutputChannel) { }

	private async snapshot(repository: Repository): Promise<Map<string, string>> {
		return parseRefSnapshot(await repository.git.forEachRef('%(refname)%00%(objectname)', ['refs/remotes', 'refs/tags']));
	}

	/** Fetches from a remote (or URL) and reports which remote-tracking branches and tags changed. */
	async fetch(repository: Repository, options: { remote?: string; ref?: string; prune?: boolean } = {}): Promise<RefChanges> {
		const before = await this.snapshot(repository);
		await repository.api.fetch({ remote: options.remote, ref: options.ref, prune: options.prune });
		const after = await this.snapshot(repository);
		await repository.refresh();
		const changes = diffRefs(before, after);
		this.log.info(`fetch ${options.remote ?? ''} ${options.ref ?? ''} in ${repository.git.root}: `
			+ `updated ${changes.updated.join(', ') || '-'}; new ${changes.created.join(', ') || '-'}; deleted ${changes.deleted.join(', ') || '-'}`);
		return changes;
	}

	/** Pulls the current branch from its upstream. */
	async pull(repository: Repository): Promise<void> {
		await repository.api.pull();
		await repository.refresh();
	}

	/** Pulls several repositories, a few at a time; resolves to the ones that failed. */
	async pullAll(repositories: readonly Repository[], concurrency: number): Promise<{ repository: Repository; error: string }[]> {
		const failures: { repository: Repository; error: string }[] = [];
		const queue = [...repositories];
		const worker = async () => {
			for (let repository = queue.shift(); repository; repository = queue.shift()) {
				try {
					await this.pull(repository);
				} catch (error) {
					failures.push({ repository, error: error instanceof Error ? error.message : String(error) });
				}
			}
		};
		await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, repositories.length)) }, worker));
		return failures;
	}

	/**
	 * Fetches a branch of a remote and merges or rebases the current branch onto it (EGit's Pull…).
	 * Resolves to 'conflicts' when Git stops for the user to resolve them.
	 */
	async pullFrom(repository: Repository, pull: PullFrom): Promise<'done' | 'conflicts'> {
		const current = repository.api.state.HEAD?.name;
		await repository.api.fetch({ remote: pull.remote, ref: pull.branch });
		let result: 'done' | 'conflicts' = 'done';
		try {
			await repository.git.mutate(pull.mode === 'rebase' ? ['rebase', 'FETCH_HEAD'] : ['merge', '--no-edit', 'FETCH_HEAD']);
		} catch (error) {
			if (await repository.git.operation() === 'none') {
				throw error;
			}
			result = 'conflicts';
		}
		if (pull.setUpstream && current) {
			await this.branches.configureBranch(repository, current, { remote: pull.remote, branch: pull.branch, mode: pull.mode });
		}
		await repository.refresh();
		return result;
	}

	/** Pushes a local branch to a branch of a remote (EGit's Push Branch…). */
	async pushBranch(repository: Repository, push: PushBranch): Promise<void> {
		await repository.api.push(push.remote, `refs/heads/${push.local}:refs/heads/${push.remoteBranch}`,
			push.upstreamMode !== undefined, push.force ? ForcePushMode.ForceWithLease : undefined);
		if (push.upstreamMode) {
			await repository.git.setConfig(`branch.${push.local}.rebase`, push.upstreamMode === 'rebase' ? 'true' : undefined);
		}
		await repository.refresh();
	}

	/** Pushes refspecs as they are typed, one after the other (EGit's Push…). */
	async pushRefspecs(repository: Repository, remote: string, refspecs: readonly string[], force: boolean): Promise<void> {
		for (const refspec of refspecs) {
			await repository.api.push(remote, refspec, false, force ? ForcePushMode.ForceWithLease : undefined);
		}
		await repository.refresh();
	}

	async deleteRemoteBranch(repository: Repository, remote: string, branch: string): Promise<void> {
		await repository.api.push(remote, `:refs/heads/${branch}`);
		await this.fetch(repository, { remote, prune: true }).catch(() => undefined);
	}

	/**
	 * Shows what a push would do. The built-in API has no dry run, so it runs in the integrated
	 * terminal, where VS Code's Git credential prompts are available.
	 */
	dryRun(repository: Repository, remote: string, refspecs: readonly string[]): vscode.Terminal {
		const terminal = vscode.window.createTerminal({ name: vscode.l10n.t('Git Push (dry run)'), cwd: repository.rootUri });
		terminal.show();
		terminal.sendText(['git', 'push', '--dry-run', '--verbose', quote(remote), ...refspecs.map(quote)].join(' '));
		return terminal;
	}

	async addRemote(repository: Repository, name: string, url: string): Promise<void> {
		await repository.git.run(['remote', 'add', name, url]);
		await repository.refresh();
	}

	async removeRemote(repository: Repository, name: string): Promise<void> {
		await repository.git.run(['remote', 'remove', name]);
		await repository.refresh();
	}

	async renameRemote(repository: Repository, from: string, to: string): Promise<void> {
		await repository.git.run(['remote', 'rename', from, to]);
		await repository.refresh();
	}

	/** Writes a remote's URL, push URLs, refspecs, tag option and prune setting. */
	async saveRemote(repository: Repository, remote: RemoteInfo): Promise<void> {
		const key = (variable: string) => `remote.${remote.name}.${variable}`;
		await repository.git.setConfig(key('url'), remote.url);
		await repository.git.setConfigValues(key('pushurl'), remote.pushUrls);
		await repository.git.setConfigValues(key('fetch'), remote.fetch);
		await repository.git.setConfigValues(key('push'), remote.push);
		await repository.git.setConfig(key('tagOpt'), remote.tagOpt || undefined);
		await repository.git.setConfig(key('prune'), remote.prune || undefined);
		await repository.refresh();
	}
}

/** Describes fetch results for a notification. */
export function describeChanges(remote: string, changes: RefChanges): string {
	const { updated, created, deleted } = changes;
	if (!updated.length && !created.length && !deleted.length) {
		return vscode.l10n.t('{0}: already up to date.', remote);
	}
	return vscode.l10n.t('{0}: {1} updated, {2} new, {3} deleted.', remote, updated.length, created.length, deleted.length);
}
