import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { Repository } from '../repository';
import { readRemotes } from './branchService';
import { isRefspec, RemoteInfo } from './model';
import { describeChanges, RemoteService } from './remoteService';

type FromWebview =
	| { type: 'ready' }
	| { type: 'save'; remote: RemoteInfo; then: 'none' | 'fetch' | 'push' | 'dryRun' };

function strings(): Record<string, string> {
	const t = vscode.l10n.t;
	return {
		url: t('URL'),
		urlHint: t('Used for fetching, and for pushing unless push URLs are given.'),
		pushUrls: t('Push URLs'),
		pushUrlsHint: t('One per line. When given, pushes go to every one of them instead of the URL.'),
		fetchSpecs: t('Fetch Refspecs'),
		fetchSpecsHint: t('One per line, e.g. +refs/heads/*:refs/remotes/origin/*'),
		pushSpecs: t('Push Refspecs'),
		pushSpecsHint: t('One per line, e.g. refs/heads/main:refs/for/main. Empty: Git\'s push.default decides.'),
		tags: t('Tags'),
		tagsAuto: t('Fetch tags that point into fetched history (default)'),
		tagsAll: t('Fetch all tags'),
		tagsNone: t('Do not fetch tags'),
		prune: t('Prune'),
		pruneDefault: t('As fetch.prune says (default)'),
		pruneYes: t('Delete remote-tracking branches that are gone on the remote'),
		pruneNo: t('Keep them'),
		save: t('Save'),
		saveFetch: t('Save and Fetch'),
		savePush: t('Save and Push'),
		dryRun: t('Dry Run'),
		invalidUrl: t('Enter the URL of the remote repository.'),
		invalidSpec: t('"{0}" is not a valid refspec.')
	};
}

/** EGit's Configure Fetch / Configure Push dialogs, as one editor per remote. */
export class RemoteEditors implements vscode.Disposable {
	private readonly panels = new Map<string, vscode.WebviewPanel>();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly remotes: RemoteService,
		private readonly onSaved: (repository: Repository) => void
	) { }

	async open(repository: Repository, name: string): Promise<void> {
		const key = `${repository.git.root}\0${name}`;
		const existing = this.panels.get(key);
		if (existing) {
			existing.reveal();
			return;
		}
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		const panel = vscode.window.createWebviewPanel('indexEditor.remote', vscode.l10n.t('Remote {0} ({1})', name, repository.name),
			vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: true });
		panel.webview.html = this.html(panel.webview, media);
		this.panels.set(key, panel);
		panel.onDidDispose(() => this.panels.delete(key));

		const post = (message: unknown) => panel.webview.postMessage(message);
		const sendState = async () => {
			const remote = (await readRemotes(repository)).find(candidate => candidate.name === name);
			if (!remote) {
				panel.dispose();
				vscode.window.showWarningMessage(vscode.l10n.t('The remote {0} no longer exists.', name));
				return;
			}
			await post({ type: 'state', remote });
		};
		panel.webview.onDidReceiveMessage(async (message: FromWebview) => {
			try {
				if (message.type === 'ready') {
					await sendState();
					return;
				}
				const remote = { ...message.remote, name };
				const problem = !remote.url.trim() ? vscode.l10n.t('Enter the URL of the remote repository.')
					: [...remote.fetch, ...remote.push].find(spec => !isRefspec(spec));
				if (problem) {
					await post({ type: 'result', ok: false, message: remote.url.trim() ? vscode.l10n.t('"{0}" is not a valid refspec.', problem) : problem });
					return;
				}
				await post({ type: 'busy', busy: true });
				await this.remotes.saveRemote(repository, remote);
				this.onSaved(repository);
				let result = vscode.l10n.t('Saved.');
				if (message.then === 'fetch') {
					result = describeChanges(name, await this.remotes.fetch(repository, { remote: name }));
				} else if (message.then === 'push') {
					await repository.api.push(name);
					result = vscode.l10n.t('Pushed to {0}', name);
				} else if (message.then === 'dryRun') {
					this.remotes.dryRun(repository, name, remote.push);
					result = vscode.l10n.t('Saved. The dry run is in the terminal.');
				}
				this.onSaved(repository);
				await post({ type: 'result', ok: true, message: result });
				await sendState();
			} catch (error) {
				await post({ type: 'result', ok: false, message: error instanceof Error ? error.message : String(error) });
			} finally {
				await post({ type: 'busy', busy: false });
			}
		});
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = randomBytes(16).toString('base64');
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'remote.js'));
		const base = webview.asWebviewUri(vscode.Uri.joinPath(media, 'commit.css'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'remote.css'));
		const text = JSON.stringify(strings()).replace(/</g, '\\u003c');
		return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${base}">
<link rel="stylesheet" href="${style}">
</head>
<body>
<script nonce="${nonce}">window.INDEX_EDITOR_STRINGS = ${text};</script>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}

	dispose(): void {
		this.panels.forEach(panel => panel.dispose());
	}
}
