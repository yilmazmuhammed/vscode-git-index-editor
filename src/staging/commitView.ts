import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { Operation } from '../git';
import { Repository, RepositoryManager } from '../repository';
import { CommitRequest, CommitService } from './commitService';
import { stripComments } from './strip';
import { StagingController } from './stagingView';

/** What the webview shows; sent whenever the repository or its state changes. */
interface ViewState {
	readonly repository: string | undefined;
	/** Repository name and branch, as the Staging lists show it. */
	readonly repositoryLabel: string | undefined;
	readonly multipleRepositories: boolean;
	readonly operation: Operation;
	readonly stagedCount: number;
	readonly authorDefault: string;
	readonly committerDefault: string;
	readonly authorHistory: string[];
	readonly committerHistory: string[];
	readonly signOffDefault: boolean;
}

type FromWebview =
	| { type: 'ready' }
	| { type: 'commit'; request: CommitRequest }
	| { type: 'amendChanged'; checked: boolean }
	| { type: 'history' }
	| { type: 'draft'; message: string }
	| { type: 'continue' }
	| { type: 'abort' }
	| { type: 'selectRepository' };

const DRAFTS_KEY = 'indexEditor.commit.drafts';

function strings(): Record<string, string> {
	const t = vscode.l10n.t;
	return {
		message: t('Commit Message'),
		placeholder: t('Message (Ctrl+Enter to commit)'),
		previous: t('Previous Messages'),
		summary: t('Summary: {0} characters'),
		summaryLong: t('Summary: {0} characters; keep it under 50'),
		secondLine: t('The second line should be empty.'),
		amend: t('Amend'),
		signOff: t('Sign-off'),
		author: t('Author'),
		committer: t('Committer'),
		commit: t('Commit'),
		commitAndPush: t('Commit and Push'),
		pushHead: t('Push HEAD'),
		amendPublished: t('HEAD is already on a remote branch; amending rewrites published history.'),
		noRepository: t('No Git repository is open.'),
		merge: t('Merging: resolve the conflicts, add the files to the Index and commit.'),
		rebase: t('Rebasing: resolve the conflicts, add the files to the Index and continue.'),
		cherryPick: t('Cherry-picking: resolve the conflicts, add the files to the Index and commit.'),
		revert: t('Reverting: resolve the conflicts, add the files to the Index and commit.'),
		continue: t('Continue'),
		abort: t('Abort'),
		repository: t('Repository: {0}'),
		changeRepository: t('Change')
	};
}

/** The commit area of the Staging view (message, amend, sign-off, author, committer, commit buttons). */
export class CommitViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewId = 'indexEditor.staging.commit';

	private view: vscode.WebviewView | undefined;
	private shownRepository: Repository | undefined;
	/** The webview has loaded and shown the repository's message. */
	private webviewReady = false;
	/** A commit asked for by command before the webview was ready; true means amend. */
	private pendingSubmit: boolean | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly manager: RepositoryManager,
		private readonly controller: StagingController,
		private readonly commits: CommitService,
		private readonly log: vscode.LogOutputChannel
	) {
		this.disposables.push(
			controller.onDidChangeRepository(() => void this.showRepository()),
			manager.onDidChange(repository => {
				if (repository === this.controller.repository) {
					void this.postState();
				}
			}),
			manager.onDidChangeRepositories(() => void this.postState()),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('indexEditor.commit')) {
					void this.postState();
				}
			})
		);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		view.webview.html = this.html(view.webview, media);
		view.webview.onDidReceiveMessage(message => void this.receive(message as FromWebview).catch(error => {
			const text = error instanceof Error ? error.message : String(error);
			this.log.error(text);
			vscode.window.showErrorMessage(text);
			void this.post({ type: 'busy', busy: false });
		}));
		view.onDidDispose(() => {
			this.view = undefined;
			this.webviewReady = false;
		});
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = randomBytes(16).toString('base64');
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'commit.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'commit.css'));
		const text = JSON.stringify(strings()).replace(/</g, '\\u003c');
		return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
</head>
<body>
<script nonce="${nonce}">window.EGIT_STRINGS = ${text};</script>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}

	private post(message: unknown): Thenable<boolean> | undefined {
		return this.view?.webview.postMessage(message);
	}

	private drafts(): Record<string, string> {
		return this.context.workspaceState.get<Record<string, string>>(DRAFTS_KEY, {});
	}

	private async saveDraft(repository: Repository, message: string): Promise<void> {
		const drafts = { ...this.drafts() };
		if (message.trim()) {
			drafts[repository.git.root] = message;
		} else {
			delete drafts[repository.git.root];
		}
		await this.context.workspaceState.update(DRAFTS_KEY, drafts);
	}

	/** The draft of the repository, else what Git prepared for an operation, else the commit template. */
	private async initialMessage(repository: Repository): Promise<string> {
		const draft = this.drafts()[repository.git.root];
		if (draft) {
			return draft;
		}
		const commentChar = await repository.git.config('core.commentChar') ?? '#';
		if (await repository.git.operation() !== 'none') {
			const prepared = await repository.git.preparedMessage();
			if (prepared) {
				return stripComments(prepared, commentChar);
			}
		}
		const template = await repository.git.commitTemplate();
		return template ? stripComments(template, commentChar) : '';
	}

	private async state(): Promise<ViewState> {
		const repository = this.controller.repository;
		const ident = await repository?.git.userIdent() ?? '';
		return {
			repository: repository?.name,
			repositoryLabel: this.controller.describeRepository(),
			multipleRepositories: this.manager.all.length > 1,
			operation: repository ? await repository.git.operation() : 'none',
			stagedCount: repository?.api.state.indexChanges.length ?? 0,
			authorDefault: ident,
			committerDefault: ident,
			authorHistory: this.commits.history('author'),
			committerHistory: this.commits.history('committer'),
			signOffDefault: vscode.workspace.getConfiguration('indexEditor.commit').get<boolean>('signOffByDefault', false)
		};
	}

	private async postState(): Promise<void> {
		if (this.view) {
			await this.post({ type: 'state', state: await this.state() });
		}
	}

	/**
	 * For the Commit and Commit (Amend) commands: commits what the commit area holds, as the
	 * webview's own button would. Opens the commit area first when it is not showing.
	 */
	async submit(amend: boolean): Promise<void> {
		this.pendingSubmit = amend;
		await vscode.commands.executeCommand(`${CommitViewProvider.viewId}.focus`);
		if (this.webviewReady) {
			this.flushSubmit();
		}
	}

	private flushSubmit(): void {
		if (this.pendingSubmit !== undefined) {
			void this.post({ type: 'submit', amend: this.pendingSubmit });
			this.pendingSubmit = undefined;
		}
	}

	/** Shows the repository the Staging view switched to, with its own draft. */
	private async showRepository(): Promise<void> {
		const repository = this.controller.repository;
		if (!this.view || repository === this.shownRepository) {
			await this.postState();
			return;
		}
		this.shownRepository = repository;
		await this.postState();
		await this.post({ type: 'reset', message: repository ? await this.initialMessage(repository) : '' });
	}

	private async receive(message: FromWebview): Promise<void> {
		const repository = this.controller.repository;
		switch (message.type) {
			case 'ready':
				this.shownRepository = undefined;
				await this.showRepository();
				this.webviewReady = true;
				this.flushSubmit();
				return;
			case 'draft':
				if (repository) {
					await this.saveDraft(repository, message.message);
				}
				return;
			case 'history': {
				const history = this.commits.history('message');
				if (!history.length) {
					vscode.window.showInformationMessage(vscode.l10n.t('No previous commit messages yet.'));
					return;
				}
				const picked = await vscode.window.showQuickPick(
					history.map(text => ({ label: text.split('\n')[0], detail: text.includes('\n') ? text : undefined, text })),
					{ title: vscode.l10n.t('Previous Messages'), matchOnDetail: true });
				if (picked) {
					await this.post({ type: 'setMessage', message: picked.text });
				}
				return;
			}
			case 'amendChanged':
				if (!repository) {
					return;
				}
				if (message.checked) {
					const [head, published] = await Promise.all([repository.git.headMessage(), repository.git.isHeadPublished()]);
					await this.post({ type: 'amend', message: head ?? '', published });
				}
				return;
			case 'continue':
				if (repository) {
					await repository.git.rebaseContinue();
					await repository.refresh();
				}
				return;
			case 'selectRepository':
				await vscode.commands.executeCommand('indexEditor.staging.selectRepository');
				return;
			case 'abort':
				if (repository && await this.confirmAbort(repository)) {
					const operation = await repository.git.operation();
					await (operation === 'rebase' ? repository.git.rebaseAbort() : repository.git.mergeAbort());
					await repository.refresh();
				}
				return;
			case 'commit':
				await this.post({ type: 'busy', busy: true });
				try {
					if (repository && await this.commits.commit(repository, message.request)) {
						await this.saveDraft(repository, '');
						await this.post({ type: 'reset', message: await this.initialMessage(repository) });
					}
				} finally {
					await this.post({ type: 'busy', busy: false });
					await this.postState();
				}
				return;
		}
	}

	private async confirmAbort(repository: Repository): Promise<boolean> {
		const abort = vscode.l10n.t('Abort');
		const operation = await repository.git.operation();
		const text = operation === 'rebase'
			? vscode.l10n.t('Abort the rebase? The branch returns to where it was before the rebase started.')
			: vscode.l10n.t('Abort the merge? The conflict resolutions made so far are lost.');
		return await vscode.window.showWarningMessage(text, { modal: true }, abort) === abort;
	}

	/** For tests and commands: commits with the given request in the view's repository. */
	async commitFromCommand(request: CommitRequest): Promise<boolean> {
		const repository = this.controller.repository;
		if (!repository) {
			return false;
		}
		const done = await this.commits.commit(repository, request);
		if (done) {
			await this.saveDraft(repository, '');
			await this.post({ type: 'reset', message: await this.initialMessage(repository) });
		}
		await this.postState();
		return done;
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}
}
