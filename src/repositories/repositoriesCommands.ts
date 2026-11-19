import * as vscode from 'vscode';
import { Repository, RepositoryManager } from '../repository';
import { CommitService } from '../staging/commitService';
import { StagingController } from '../staging/stagingView';
import { BranchService, PullMode, readRefs, readRemotes } from './branchService';
import { isRefspec, RefInfo, splitRefspecs, suggestBranchName } from './model';
import { RemoteEditors } from './remoteEditor';
import { describeChanges, RemoteService } from './remoteService';
import { RepositoriesView, RepositoryTreeNode } from './repositoriesView';

type Register = (id: string, handler: (...args: any[]) => unknown) => vscode.Disposable;
type Pick<T> = vscode.QuickPickItem & { value?: T };

const t = vscode.l10n.t;

function separator(label: string): Pick<never> {
	return { label, kind: vscode.QuickPickItemKind.Separator };
}

async function pick<T>(items: Pick<T>[], options: vscode.QuickPickOptions & { active?: T }): Promise<T | undefined> {
	const picked = await vscode.window.showQuickPick(items, options);
	return picked?.value;
}

/** Asks for one choice with a default, shown first. */
async function choose<T>(title: string, choices: { label: string; detail?: string; value: T }[], current?: T): Promise<T | undefined> {
	const sorted = current === undefined ? choices : [...choices].sort((a, b) => Number(b.value === current) - Number(a.value === current));
	return pick(sorted.map(choice => ({ label: choice.label, detail: choice.detail, value: choice.value })), { title });
}

function pullModeChoices(): { label: string; value: PullMode }[] {
	return [
		{ label: t('Merge'), value: 'merge' },
		{ label: t('Rebase'), value: 'rebase' }
	];
}

/** Registers the commands of the Repositories view: branches, remotes, fetch, pull and push. */
export function registerRepositoriesCommands(
	register: Register,
	manager: RepositoryManager,
	view: RepositoriesView,
	branches: BranchService,
	remotes: RemoteService,
	remoteEditors: RemoteEditors,
	commits: CommitService,
	staging: StagingController
): vscode.Disposable {
	/** Repositories from the clicked or selected nodes, else the Staging view's, else asked for. */
	const targetRepositories = async (args: readonly unknown[]): Promise<Repository[]> => {
		const fromNodes = view.repositoriesFromArgs(args);
		if (fromNodes.length) {
			return fromNodes;
		}
		if (staging.repository) {
			return [staging.repository];
		}
		await manager.ready;
		const repository = await pick(manager.all.map(candidate => ({ label: candidate.name, description: candidate.git.root, value: candidate })),
			{ title: t('Select Repository') });
		return repository ? [repository] : [];
	};
	const targetRepository = async (args: readonly unknown[]) => (await targetRepositories(args))[0];

	const refNodes = (args: readonly unknown[], kind: RefInfo['kind']) => view.nodesOrSelection(args)
		.flatMap(node => node.kind === 'ref' && node.ref.kind === kind ? [node] : []);

	const withProgress = <T>(title: string, task: () => Promise<T>) =>
		vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);

	const validateBranchName = (repository: Repository, refs: readonly RefInfo[], except?: string) => async (value: string) => {
		const name = value.trim();
		if (!name) {
			return t('Enter a branch name.');
		}
		if (!await repository.git.isValidBranchName(name)) {
			return t('"{0}" is not a valid branch name.', name);
		}
		if (name !== except && refs.some(ref => ref.kind === 'local' && ref.name === name)) {
			return t('A branch named "{0}" already exists.', name);
		}
		return undefined;
	};

	// ---- branches

	const createBranch = async (repository: Repository, start?: { name: string; ref?: RefInfo }) => {
		const refs = await readRefs(repository);
		let startName = start?.name;
		let startRef = start?.ref;
		if (!startName) {
			const describe = (ref: RefInfo) => ({ label: ref.name, description: ref.isHead ? t('checked out') : undefined, detail: ref.subject, value: ref });
			const items: Pick<RefInfo | 'custom'>[] = [
				{ label: `$(edit) ${t('Commit or Ref…')}`, value: 'custom' },
				separator(t('Local')), ...refs.filter(ref => ref.kind === 'local').map(describe),
				separator(t('Remote Tracking')), ...refs.filter(ref => ref.kind === 'remote').map(describe),
				separator(t('Tags')), ...refs.filter(ref => ref.kind === 'tag').map(describe)
			];
			const picked = await pick(items, { title: t('Create Branch: Start From'), placeHolder: t('The branch, tag or commit the new branch starts from'), matchOnDetail: true });
			if (!picked) {
				return;
			}
			if (picked === 'custom') {
				startName = (await vscode.window.showInputBox({
					title: t('Create Branch: Start From'),
					prompt: t('A commit ID or any ref'),
					validateInput: async value => value.trim() && await repository.git.resolveCommit(value.trim()) ? undefined : t('No commit found for "{0}".', value)
				}))?.trim();
				if (!startName) {
					return;
				}
			} else {
				startRef = picked;
				startName = picked.name;
			}
		}
		const name = (await vscode.window.showInputBox({
			title: t('Create Branch: Name'),
			value: suggestBranchName(startRef),
			prompt: t('Starts from {0}', startName),
			validateInput: validateBranchName(repository, refs)
		}))?.trim();
		if (!name) {
			return;
		}
		let upstreamMode: PullMode | undefined;
		if (startRef?.kind === 'remote') {
			const mode = await choose<PullMode | 'none'>(t('Create Branch: Upstream'), [
				{ label: t('Track {0}; pull with merge', startRef.name), value: 'merge' },
				{ label: t('Track {0}; pull with rebase', startRef.name), value: 'rebase' },
				{ label: t('Do not track it'), value: 'none' }
			]);
			if (!mode) {
				return;
			}
			upstreamMode = mode === 'none' ? undefined : mode;
		}
		const checkout = await choose(t('Create Branch'), [
			{ label: t('Create and Check Out'), value: true },
			{ label: t('Create Only'), value: false }
		]);
		if (checkout === undefined) {
			return;
		}
		await branches.createBranch(repository, { name, start: startName, upstreamMode, checkout });
	};

	const checkout = async (node: RepositoryTreeNode | undefined) => {
		if (!node) {
			return;
		}
		const repository = node.repository;
		if (node.kind === 'ref' && node.ref.kind === 'local') {
			if (!node.ref.isHead) {
				await branches.checkout(repository, node.ref.name);
			}
		} else if (node.kind === 'ref' && node.ref.kind === 'remote') {
			await branches.checkoutRemote(repository, node.ref);
		} else if (node.kind === 'reference' || (node.kind === 'ref' && node.ref.kind === 'tag')) {
			const name = node.kind === 'reference' ? node.name : node.ref.name;
			const commit = node.kind === 'reference' ? node.commit : node.ref.commit;
			const detached = t('Check Out Detached');
			const newBranch = t('Create Branch…');
			const answer = await vscode.window.showWarningMessage(
				t('Checking out {0} detaches HEAD: new commits will belong to no branch.', name),
				{ modal: true }, detached, newBranch);
			if (answer === detached) {
				await branches.checkout(repository, commit, { detach: true });
			} else if (answer === newBranch) {
				await createBranch(repository, { name: commit });
			}
		}
	};

	const switchTo = async (repositories: Repository[]) => {
		if (!repositories.length) {
			return;
		}
		const localNames = await Promise.all(repositories.map(async repository =>
			(await readRefs(repository)).filter(ref => ref.kind === 'local').map(ref => ref.name)));
		const common = localNames.reduce((all, names) => all.filter(name => names.includes(name)));
		const recent = (await branches.recent(repositories[0], common));
		const current = repositories.length === 1 ? repositories[0].api.state.HEAD?.name : undefined;
		const items: Pick<string | 'new'>[] = [
			{ label: `$(add) ${t('New Branch…')}`, value: 'new' },
			separator(t('Recent')), ...recent.map(name => ({ label: name, description: name === current ? t('checked out') : undefined, value: name })),
			separator(t('All Branches')), ...common.filter(name => !recent.includes(name))
				.map(name => ({ label: name, description: name === current ? t('checked out') : undefined, value: name }))
		];
		const title = repositories.length === 1 ? t('Switch To') : t('Switch {0} Repositories To', repositories.length);
		const picked = await pick(items, { title });
		if (!picked) {
			return;
		}
		if (picked === 'new') {
			if (repositories.length === 1) {
				await createBranch(repositories[0]);
				return;
			}
			const name = (await vscode.window.showInputBox({
				title: t('New Branch in {0} Repositories', repositories.length),
				prompt: t('Created from HEAD in every repository and checked out'),
				validateInput: async value => value.trim() && await repositories[0].git.isValidBranchName(value.trim()) ? undefined : t('"{0}" is not a valid branch name.', value)
			}))?.trim();
			if (!name) {
				return;
			}
			const failures: string[] = [];
			for (const repository of repositories) {
				try {
					await branches.createBranch(repository, { name, start: 'HEAD', checkout: true });
				} catch (error) {
					failures.push(`${repository.name}: ${error instanceof Error ? error.message : error}`);
				}
			}
			if (failures.length) {
				vscode.window.showWarningMessage(t('The branch could not be created everywhere.'), { detail: failures.join('\n'), modal: true });
			}
			return;
		}
		const failures = await branches.switchAll(repositories, picked);
		if (failures.length) {
			vscode.window.showWarningMessage(t('Could not switch {0} of {1} repositories to {2}.', failures.length, repositories.length, picked),
				{ modal: true, detail: failures.map(failure => `${failure.repository.name}: ${failure.error}`).join('\n') });
		}
	};

	const configureBranch = async (repository: Repository, name: string) => {
		const [refs, remoteList] = await Promise.all([readRefs(repository), readRemotes(repository)]);
		const branch = refs.find(ref => ref.kind === 'local' && ref.name === name);
		const target = await pick<string | 'remove'>([
			...remoteList.map(remote => ({ label: remote.name, description: remote.url, value: remote.name })),
			{ label: t('Local Repository'), description: '.', value: '.' },
			separator(''),
			{ label: `$(close) ${t('Remove Upstream')}`, value: 'remove' }
		], { title: t('Configure Branch {0}: Upstream Remote', name), placeHolder: branch?.upstream ? t('Now: {0}', branch.upstream) : t('No upstream yet') });
		if (!target) {
			return;
		}
		if (target === 'remove') {
			await branches.configureBranch(repository, name, undefined);
			return;
		}
		const candidates = target === '.'
			? refs.filter(ref => ref.kind === 'local' && ref.name !== name).map(ref => ref.name)
			: refs.filter(ref => ref.kind === 'remote' && ref.remote === target).map(ref => ref.remoteBranch ?? ref.name);
		let upstreamBranch = await pick<string | 'other'>([
			...candidates.map(candidate => ({ label: candidate, value: candidate })),
			{ label: `$(edit) ${t('Other…')}`, value: 'other' }
		], { title: t('Configure Branch {0}: Upstream Branch', name) });
		if (upstreamBranch === 'other') {
			upstreamBranch = (await vscode.window.showInputBox({ title: t('Configure Branch {0}: Upstream Branch', name), value: name }))?.trim();
		}
		if (!upstreamBranch) {
			return;
		}
		const mode = await choose(t('Configure Branch {0}: Pull Mode', name), pullModeChoices(), await branches.pullMode(repository, name));
		if (mode) {
			await branches.configureBranch(repository, name, { remote: target, branch: upstreamBranch, mode });
		}
	};

	// ---- remotes

	const pickRemote = async (repository: Repository, title: string, preferred?: string, allowNew = false): Promise<string | undefined> => {
		const remoteList = await readRemotes(repository);
		if (!remoteList.length && !allowNew) {
			vscode.window.showInformationMessage(t('{0} has no remotes.', repository.name));
			return undefined;
		}
		const items: Pick<string | 'new'>[] = remoteList
			.sort((a, b) => Number(b.name === preferred) - Number(a.name === preferred))
			.map(remote => ({ label: remote.name, description: remote.url, value: remote.name }));
		if (allowNew) {
			items.push({ label: `$(add) ${t('New Remote…')}`, value: 'new' });
		}
		const picked = await pick(items, { title });
		return picked === 'new' ? createRemote(repository) : picked;
	};

	const createRemote = async (repository: Repository): Promise<string | undefined> => {
		const existing = (await readRemotes(repository)).map(remote => remote.name);
		const name = (await vscode.window.showInputBox({
			title: t('Create Remote: Name'),
			value: existing.length ? '' : 'origin',
			validateInput: value => !/^[^\s~^:?*[\\]+$/.test(value.trim()) ? t('Enter a remote name without spaces.')
				: existing.includes(value.trim()) ? t('A remote named "{0}" already exists.', value.trim()) : undefined
		}))?.trim();
		if (!name) {
			return undefined;
		}
		const url = (await vscode.window.showInputBox({
			title: t('Create Remote {0}: URL', name),
			placeHolder: 'https://… / git@…:… / C:\\path\\to\\repo.git',
			validateInput: value => value.trim() ? undefined : t('Enter the URL of the remote repository.')
		}))?.trim();
		if (!url) {
			return undefined;
		}
		await remotes.addRemote(repository, name, url);
		view.refresh(repository);
		return name;
	};

	/** The remote to fetch from by default: the upstream's, else origin, else the only one. */
	const defaultRemote = async (repository: Repository): Promise<string | undefined> => {
		const upstream = repository.api.state.HEAD?.upstream?.remote;
		if (upstream && upstream !== '.') {
			return upstream;
		}
		const names = (await readRemotes(repository)).map(remote => remote.name);
		return names.includes('origin') ? 'origin' : names[0];
	};

	const fetch = async (repositories: Repository[], remote?: string) => {
		const messages: string[] = [];
		await withProgress(t('Fetching…'), async () => {
			for (const repository of repositories) {
				const from = remote ?? await defaultRemote(repository);
				if (!from) {
					messages.push(t('{0} has no remotes.', repository.name));
					continue;
				}
				const changes = await remotes.fetch(repository, { remote: from });
				const text = describeChanges(from, changes);
				messages.push(repositories.length > 1 ? `${repository.name} – ${text}` : text);
				view.refresh(repository);
			}
		});
		vscode.window.showInformationMessage(messages.join(' '));
	};

	const reportConflicts = async (repository: Repository) => {
		if (await repository.git.operation() !== 'none') {
			const show = t('Show in Git Staging');
			if (await vscode.window.showWarningMessage(t('{0}: Git stopped on conflicts. Resolve them, add the files to the Index and commit or continue.', repository.name), show) === show) {
				staging.selectRepository(repository);
				await vscode.commands.executeCommand('indexEditor.staging.unstaged.focus');
			}
			return true;
		}
		return false;
	};

	const pull = async (repositories: Repository[]) => {
		const concurrency = vscode.workspace.getConfiguration('indexEditor.repositories').get<number>('pullConcurrency', 3);
		const failures = await withProgress(t('Pulling…'), () => remotes.pullAll(repositories, concurrency));
		for (const repository of repositories) {
			view.refresh(repository);
		}
		const others: string[] = [];
		for (const failure of failures) {
			if (!await reportConflicts(failure.repository)) {
				others.push(`${failure.repository.name}: ${failure.error}`);
			}
		}
		if (others.length) {
			vscode.window.showErrorMessage(repositories.length > 1
				? t('Pull failed in {0} of {1} repositories.', others.length, repositories.length)
				: t('Pull failed.'), { modal: true, detail: others.join('\n') });
		} else if (!failures.length) {
			vscode.window.setStatusBarMessage(t('Pulled {0} repositories.', repositories.length), 5000);
		}
	};

	const pullWith = async (repository: Repository) => {
		const head = repository.api.state.HEAD;
		const remote = await pickRemote(repository, t('Pull: Remote'), head?.upstream?.remote);
		if (!remote) {
			return;
		}
		await withProgress(t('Fetching…'), () => remotes.fetch(repository, { remote }));
		const remoteBranches = (await readRefs(repository)).filter(ref => ref.kind === 'remote' && ref.remote === remote);
		let branch = await pick<string | 'other'>([
			...remoteBranches
				.sort((a, b) => Number(b.remoteBranch === head?.upstream?.name) - Number(a.remoteBranch === head?.upstream?.name))
				.map(ref => ({ label: ref.remoteBranch ?? ref.name, detail: ref.subject, value: ref.remoteBranch ?? ref.name })),
			{ label: `$(edit) ${t('Other…')}`, value: 'other' }
		], { title: t('Pull from {0}: Branch', remote) });
		if (branch === 'other') {
			branch = (await vscode.window.showInputBox({ title: t('Pull from {0}: Branch', remote) }))?.trim();
		}
		if (!branch) {
			return;
		}
		const mode = await choose(t('Pull: Mode'), pullModeChoices(), head?.name ? await branches.pullMode(repository, head.name) : 'merge');
		if (!mode) {
			return;
		}
		const setUpstream = await choose(t('Pull: Upstream'), [
			{ label: t('Just Pull'), value: false },
			{ label: t('Pull and Make {0}/{1} the Upstream', remote, branch), value: true }
		]);
		if (setUpstream === undefined) {
			return;
		}
		const result = await withProgress(t('Pulling…'), () => remotes.pullFrom(repository, { remote, branch: branch!, mode, setUpstream }));
		view.refresh(repository);
		if (result === 'conflicts') {
			await reportConflicts(repository);
		}
	};

	const pushBranch = async (repository: Repository, localName?: string) => {
		const local = localName ?? repository.api.state.HEAD?.name;
		if (!local) {
			vscode.window.showErrorMessage(t('HEAD is detached, so there is no branch to push.'));
			return;
		}
		const refs = await readRefs(repository);
		const branch = refs.find(ref => ref.kind === 'local' && ref.name === local);
		const [upstreamRemote, ...upstreamParts] = branch?.upstream?.split('/') ?? [];
		const remote = await pickRemote(repository, t('Push {0}: Remote', local), upstreamRemote, true);
		if (!remote) {
			return;
		}
		const remoteBranch = (await vscode.window.showInputBox({
			title: t('Push {0} to {1}: Remote Branch', local, remote),
			value: upstreamRemote === remote && upstreamParts.length ? upstreamParts.join('/') : local,
			validateInput: async value => value.trim() && await repository.git.isValidBranchName(value.trim()) ? undefined : t('"{0}" is not a valid branch name.', value)
		}))?.trim();
		if (!remoteBranch) {
			return;
		}
		const current = branch?.upstream ? await branches.pullMode(repository, local) : 'merge';
		const upstream = await choose<PullMode | 'none'>(t('Push {0}: Upstream', local), [
			{ label: t('Configure upstream; pull with merge'), value: 'merge' },
			{ label: t('Configure upstream; pull with rebase'), value: 'rebase' },
			{ label: t('Do not configure upstream'), value: 'none' }
		], current);
		if (!upstream) {
			return;
		}
		const force = await choose(t('Push {0}', local), [
			{ label: t('Push'), value: false },
			{ label: t('Force Push'), detail: t('Overwrites {0}/{1} unless it changed since the last fetch (--force-with-lease).', remote, remoteBranch), value: true }
		]);
		if (force === undefined) {
			return;
		}
		await withProgress(t('Pushing…'), () => remotes.pushBranch(repository, {
			local, remote, remoteBranch, upstreamMode: upstream === 'none' ? undefined : upstream, force
		}));
		view.refresh(repository);
		vscode.window.setStatusBarMessage(t('Pushed {0} to {1}', local, `${remote}/${remoteBranch}`), 5000);
	};

	const pushAdvanced = async (repository: Repository) => {
		const head = repository.api.state.HEAD;
		const remote = await pickRemote(repository, t('Push: Remote'), head?.upstream?.remote);
		if (!remote) {
			return;
		}
		const target = head?.upstream?.remote === remote ? head.upstream.name : head?.name;
		const refspecs = await vscode.window.showInputBox({
			title: t('Push to {0}: Refspecs', remote),
			prompt: t('Separate refspecs with spaces. Examples: HEAD:refs/heads/main, +topic:topic, :refs/heads/old (deletes it).'),
			value: target ? `HEAD:refs/heads/${target}` : '',
			validateInput: value => {
				const specs = splitRefspecs(value);
				const invalid = specs.find(spec => !isRefspec(spec));
				return !specs.length ? t('Enter at least one refspec.') : invalid ? t('"{0}" is not a valid refspec.', invalid) : undefined;
			}
		});
		if (!refspecs) {
			return;
		}
		const mode = await choose<'push' | 'force' | 'dryRun'>(t('Push to {0}', remote), [
			{ label: t('Push'), value: 'push' },
			{ label: t('Force Push'), detail: t('Uses --force-with-lease: refuses if the remote branch changed since the last fetch.'), value: 'force' },
			{ label: t('Dry Run'), detail: t('Shows what would be pushed, in the terminal.'), value: 'dryRun' }
		]);
		if (!mode) {
			return;
		}
		if (mode === 'dryRun') {
			remotes.dryRun(repository, remote, splitRefspecs(refspecs));
			return;
		}
		await withProgress(t('Pushing…'), () => remotes.pushRefspecs(repository, remote, splitRefspecs(refspecs), mode === 'force'));
		view.refresh(repository);
		vscode.window.setStatusBarMessage(t('Pushed to {0}', remote), 5000);
	};

	const localBranchName = (args: readonly unknown[]) => refNodes(args, 'local')[0]?.ref.name;

	return vscode.Disposable.from(
		register('indexEditor.repositories.refresh', () => view.refresh()),
		...([['showFlat', 'hierarchicalBranches', false], ['showHierarchical', 'hierarchicalBranches', true],
			['showLatestCommit', 'showLatestCommit', true], ['hideLatestCommit', 'showLatestCommit', false],
			['linkWithEditor', 'linkWithEditor', true], ['unlinkWithEditor', 'linkWithEditor', false]] as const)
			.map(([id, setting, value]) => register(`indexEditor.repositories.${id}`, () =>
				vscode.workspace.getConfiguration('indexEditor.repositories').update(setting, value, vscode.ConfigurationTarget.Global))),
		register('indexEditor.repositories.showInStaging', async (...args: unknown[]) => {
			const repository = await targetRepository(args);
			if (repository) {
				staging.selectRepository(repository);
				await vscode.commands.executeCommand('indexEditor.staging.unstaged.focus');
			}
		}),
		register('indexEditor.repositories.copyPath', async (...args: unknown[]) => {
			const repositories = await targetRepositories(args);
			await vscode.env.clipboard.writeText(repositories.map(repository => repository.git.root).join('\n'));
		}),

		register('indexEditor.repositories.checkout', (...args: unknown[]) => checkout(view.nodesFromArgs(args)[0])),
		register('indexEditor.repositories.createBranch', async (...args: unknown[]) => {
			const [node] = view.nodesFromArgs(args);
			const repository = node?.repository ?? await targetRepository(args);
			if (!repository) {
				return;
			}
			if (node?.kind === 'ref') {
				await createBranch(repository, { name: node.ref.name, ref: node.ref });
			} else if (node?.kind === 'reference') {
				await createBranch(repository, { name: node.commit });
			} else {
				await createBranch(repository);
			}
		}),
		register('indexEditor.repositories.renameBranch', async (...args: unknown[]) => {
			const node = refNodes(args, 'local')[0];
			if (!node) {
				return;
			}
			const refs = await readRefs(node.repository);
			const name = (await vscode.window.showInputBox({
				title: t('Rename Branch {0}', node.ref.name),
				value: node.ref.name,
				validateInput: validateBranchName(node.repository, refs, node.ref.name)
			}))?.trim();
			if (name && name !== node.ref.name) {
				await branches.renameBranch(node.repository, node.ref.name, name);
			}
		}),
		register('indexEditor.repositories.deleteBranch', async (...args: unknown[]) => {
			const nodes = refNodes(args, 'local');
			if (nodes.some(node => node.ref.isHead)) {
				vscode.window.showErrorMessage(t('The checked out branch cannot be deleted. Switch to another branch first.'));
				return;
			}
			for (const repository of [...new Set(nodes.map(node => node.repository))]) {
				const names = nodes.filter(node => node.repository === repository).map(node => node.ref.name);
				const { unmerged } = await branches.deleteBranches(repository, names, false);
				if (unmerged.length) {
					const deleteAnyway = t('Delete Anyway');
					if (await vscode.window.showWarningMessage(
						t('These branches have commits that are not merged into the current branch or their upstream: {0}. Delete them anyway?', unmerged.join(', ')),
						{ modal: true }, deleteAnyway) === deleteAnyway) {
						await branches.deleteBranches(repository, unmerged, true);
					}
				}
				view.refresh(repository);
			}
		}),
		register('indexEditor.repositories.configureBranch', async (...args: unknown[]) => {
			const node = refNodes(args, 'local')[0];
			const repository = node?.repository ?? await targetRepository(args);
			const name = node?.ref.name ?? repository?.api.state.HEAD?.name;
			if (repository && name) {
				await configureBranch(repository, name);
				view.refresh(repository);
			}
		}),
		register('indexEditor.repositories.switchTo', async (...args: unknown[]) => switchTo(await targetRepositories(args))),

		register('indexEditor.repositories.fetch', async (...args: unknown[]) => {
			const [node] = view.nodesFromArgs(args);
			if (node?.kind === 'remote' || node?.kind === 'remoteSpec') {
				await fetch([node.repository], node.remote.name);
			} else {
				await fetch(await targetRepositories(args));
			}
		}),
		register('indexEditor.repositories.fetchFrom', async (...args: unknown[]) => {
			const repository = await targetRepository(args);
			if (!repository) {
				return;
			}
			const remoteList = await readRemotes(repository);
			const source = await pick<string | 'url'>([
				...remoteList.map(remote => ({ label: remote.name, description: remote.url, value: remote.name })),
				{ label: `$(link) ${t('URL…')}`, value: 'url' }
			], { title: t('Fetch From') });
			if (!source) {
				return;
			}
			const remote = source === 'url'
				? (await vscode.window.showInputBox({ title: t('Fetch From: URL'), validateInput: value => value.trim() ? undefined : t('Enter the URL of the remote repository.') }))?.trim()
				: source;
			if (!remote) {
				return;
			}
			const ref = await vscode.window.showInputBox({
				title: t('Fetch From {0}: Refspec', remote),
				prompt: source === 'url' ? t('A branch or refspec; the result is in FETCH_HEAD.') : t('Leave empty to use the configured refspecs.'),
				value: source === 'url' ? 'HEAD' : ''
			});
			if (ref === undefined) {
				return;
			}
			const changes = await withProgress(t('Fetching…'), () => remotes.fetch(repository, { remote, ref: ref.trim() || undefined }));
			view.refresh(repository);
			vscode.window.showInformationMessage(source === 'url' && ref.trim()
				? t('Fetched {0} from {1} into FETCH_HEAD.', ref.trim(), remote)
				: describeChanges(remote, changes));
		}),
		register('indexEditor.repositories.pull', async (...args: unknown[]) => pull(await targetRepositories(args))),
		register('indexEditor.repositories.pullWith', async (...args: unknown[]) => {
			const repository = await targetRepository(args);
			if (repository) {
				await pullWith(repository);
			}
		}),
		register('indexEditor.repositories.pushUpstream', async (...args: unknown[]) => {
			for (const repository of await targetRepositories(args)) {
				await withProgress(t('Pushing…'), () => commits.pushHead(repository));
				view.refresh(repository);
			}
		}),
		register('indexEditor.repositories.pushBranch', async (...args: unknown[]) => {
			const node = refNodes(args, 'local')[0];
			const repository = node?.repository ?? await targetRepository(args);
			if (repository) {
				await pushBranch(repository, localBranchName(args));
			}
		}),
		register('indexEditor.repositories.push', async (...args: unknown[]) => {
			const [node] = view.nodesFromArgs(args);
			if (node?.kind === 'remote' || node?.kind === 'remoteSpec') {
				await pushBranch(node.repository);
				return;
			}
			const repository = await targetRepository(args);
			if (repository) {
				await pushAdvanced(repository);
			}
		}),
		register('indexEditor.repositories.deleteRemoteBranch', async (...args: unknown[]) => {
			const nodes = refNodes(args, 'remote');
			if (!nodes.length) {
				return;
			}
			const deleteRemote = t('Delete on Remote');
			if (await vscode.window.showWarningMessage(
				t('Delete {0} on the remote server? Other people lose access to it too.', nodes.map(node => node.ref.name).join(', ')),
				{ modal: true }, deleteRemote) !== deleteRemote) {
				return;
			}
			await withProgress(t('Pushing…'), async () => {
				for (const node of nodes) {
					await remotes.deleteRemoteBranch(node.repository, node.ref.remote!, node.ref.remoteBranch!);
					view.refresh(node.repository);
				}
			});
		}),

		register('indexEditor.repositories.createRemote', async (...args: unknown[]) => {
			const repository = await targetRepository(args);
			const name = repository && await createRemote(repository);
			if (repository && name) {
				const fetchNow = t('Fetch');
				if (await vscode.window.showInformationMessage(t('Remote {0} created.', name), fetchNow) === fetchNow) {
					await fetch([repository], name);
				}
			}
		}),
		register('indexEditor.repositories.configureRemote', async (...args: unknown[]) => {
			const [node] = view.nodesFromArgs(args);
			if (node?.kind === 'remote' || node?.kind === 'remoteSpec') {
				await remoteEditors.open(node.repository, node.remote.name);
			}
		}),
		register('indexEditor.repositories.renameRemote', async (...args: unknown[]) => {
			const [node] = view.nodesFromArgs(args);
			if (node?.kind !== 'remote') {
				return;
			}
			const existing = (await readRemotes(node.repository)).map(remote => remote.name);
			const name = (await vscode.window.showInputBox({
				title: t('Rename Remote {0}', node.remote.name),
				value: node.remote.name,
				validateInput: value => !/^[^\s~^:?*[\\]+$/.test(value.trim()) ? t('Enter a remote name without spaces.')
					: value.trim() !== node.remote.name && existing.includes(value.trim()) ? t('A remote named "{0}" already exists.', value.trim()) : undefined
			}))?.trim();
			if (name && name !== node.remote.name) {
				await remotes.renameRemote(node.repository, node.remote.name, name);
				view.refresh(node.repository);
			}
		}),
		register('indexEditor.repositories.deleteRemote', async (...args: unknown[]) => {
			const [node] = view.nodesFromArgs(args);
			if (node?.kind !== 'remote') {
				return;
			}
			const deleteIt = t('Delete');
			if (await vscode.window.showWarningMessage(
				t('Delete the remote {0}? Its remote-tracking branches and configuration are removed; nothing changes on the server.', node.remote.name),
				{ modal: true }, deleteIt) === deleteIt) {
				await remotes.removeRemote(node.repository, node.remote.name);
				view.refresh(node.repository);
			}
		})
	);
}
