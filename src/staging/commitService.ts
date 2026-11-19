import * as vscode from 'vscode';
import { parseIdent } from '../git';
import { Repository } from '../repository';
import { INDEX_SCHEME } from '../uris';

export interface CommitRequest {
	readonly message: string;
	readonly amend: boolean;
	readonly signOff: boolean;
	/** `Name <email>`; empty or equal to the configured identity means the default. */
	readonly author?: string;
	readonly committer?: string;
	/** Push the current branch after committing; with nothing to commit, only push. */
	readonly push: boolean;
}

export type HistoryKind = 'message' | 'author' | 'committer';

const HISTORY_KEYS: Record<HistoryKind, string> = {
	message: 'indexEditor.commit.messageHistory',
	author: 'indexEditor.commit.authorHistory',
	committer: 'indexEditor.commit.committerHistory'
};

/** Commits what the Index holds, with the options of the Staging view's commit area. */
export class CommitService {
	constructor(private readonly memento: vscode.Memento, private readonly log: vscode.LogOutputChannel) { }

	history(kind: HistoryKind): string[] {
		return this.memento.get<string[]>(HISTORY_KEYS[kind], []);
	}

	private async remember(kind: HistoryKind, value: string | undefined): Promise<void> {
		const text = value?.trim();
		if (!text) {
			return;
		}
		const size = vscode.workspace.getConfiguration('indexEditor.commit').get<number>('messageHistorySize', 20);
		const updated = [text, ...this.history(kind).filter(item => item !== text)].slice(0, Math.max(0, size));
		await this.memento.update(HISTORY_KEYS[kind], updated);
	}

	/** Index documents of the repository with unsaved edits, which a commit would leave out. */
	private unsavedIndexDocuments(repository: Repository): vscode.TextDocument[] {
		return vscode.workspace.textDocuments.filter(document =>
			document.uri.scheme === INDEX_SCHEME && document.isDirty && repository.relativePath(document.uri) !== undefined);
	}

	/** Counts the problems in staged files at or above the configured severity; resolves false to stop the commit. */
	private async checkProblems(repository: Repository): Promise<boolean> {
		const config = vscode.workspace.getConfiguration('indexEditor.commit');
		const mode = config.get<'off' | 'warn' | 'block'>('problemCheck', 'off');
		if (mode === 'off') {
			return true;
		}
		const threshold = config.get<'error' | 'warning'>('problemSeverity', 'error') === 'error'
			? vscode.DiagnosticSeverity.Error
			: vscode.DiagnosticSeverity.Warning;
		const count = repository.api.state.indexChanges
			.flatMap(change => vscode.languages.getDiagnostics(change.uri))
			.filter(diagnostic => diagnostic.severity <= threshold).length;
		if (!count) {
			return true;
		}
		if (mode === 'block') {
			vscode.window.showErrorMessage(vscode.l10n.t('The staged files have {0} problem(s). Fix them first, or change the setting indexEditor.commit.problemCheck.', count));
			return false;
		}
		const commitAnyway = vscode.l10n.t('Commit Anyway');
		return await vscode.window.showWarningMessage(
			vscode.l10n.t('The staged files have {0} problem(s). Commit anyway?', count), { modal: true }, commitAnyway) === commitAnyway;
	}

	private async validIdent(value: string | undefined, fallback: string | undefined, label: string): Promise<string | undefined | false> {
		const text = value?.trim();
		if (!text || text === fallback) {
			return undefined;
		}
		if (!parseIdent(text)) {
			vscode.window.showErrorMessage(vscode.l10n.t('{0} must look like "Name <email>".', label));
			return false;
		}
		return text;
	}

	/** Resolves true when something was committed or pushed. */
	async commit(repository: Repository, request: CommitRequest): Promise<boolean> {
		const unsaved = this.unsavedIndexDocuments(repository);
		if (unsaved.length) {
			const saveAndCommit = vscode.l10n.t('Save and Commit');
			const answer = await vscode.window.showWarningMessage(
				vscode.l10n.t('{0} Index document(s) have unsaved edits that would be left out of the commit.', unsaved.length),
				{ modal: true }, saveAndCommit);
			if (answer !== saveAndCommit) {
				return false;
			}
			await Promise.all(unsaved.map(document => document.save()));
		}
		await repository.refresh();
		const git = repository.git;
		const operation = await git.operation();
		const staged = repository.api.state.indexChanges.length;
		const message = request.message.replace(/\s+$/, '');

		if (request.push && !request.amend && !message && !staged && operation === 'none') {
			await this.pushHead(repository);
			return true;
		}
		if (!message && !request.amend) {
			vscode.window.showWarningMessage(vscode.l10n.t('Enter a commit message.'));
			return false;
		}
		if (!staged && !request.amend && operation === 'none') {
			vscode.window.showWarningMessage(vscode.l10n.t('There are no staged changes to commit.'));
			return false;
		}
		if (!await this.checkProblems(repository)) {
			return false;
		}
		const defaultIdent = await git.userIdent();
		const author = await this.validIdent(request.author, defaultIdent, vscode.l10n.t('Author'));
		const committer = await this.validIdent(request.committer, defaultIdent, vscode.l10n.t('Committer'));
		if (author === false || committer === false) {
			return false;
		}

		await git.commit({ message, amend: request.amend, signOff: request.signOff, author, committer });
		this.log.info(`committed in ${repository.git.root}${request.amend ? ' (amend)' : ''}`);
		await this.remember('message', message);
		await this.remember('author', author);
		await this.remember('committer', committer);
		await repository.refresh();
		if (request.push) {
			await this.pushHead(repository);
		}
		return true;
	}

	/** Pushes the current branch to its upstream, or publishes it to a remote with upstream tracking. */
	async pushHead(repository: Repository): Promise<void> {
		const head = repository.api.state.HEAD;
		if (!head?.name) {
			throw new Error(vscode.l10n.t('HEAD is detached, so there is no branch to push.'));
		}
		const upstream = head.upstream;
		if (upstream && upstream.remote !== '.') {
			await repository.api.push(upstream.remote, `${head.name}:${upstream.name}`);
			vscode.window.setStatusBarMessage(vscode.l10n.t('Pushed {0} to {1}', head.name, `${upstream.remote}/${upstream.name}`), 5000);
			return;
		}
		const remotes = repository.api.state.remotes;
		if (!remotes.length) {
			throw new Error(vscode.l10n.t('The repository has no remote to push to.'));
		}
		const remote = remotes.length === 1
			? remotes[0].name
			: (await vscode.window.showQuickPick(remotes.map(item => item.name), {
				title: vscode.l10n.t('Push {0} to', head.name)
			}));
		if (!remote) {
			return;
		}
		await repository.api.push(remote, head.name, true);
		vscode.window.setStatusBarMessage(vscode.l10n.t('Pushed {0} to {1}', head.name, `${remote}/${head.name}`), 5000);
	}
}
