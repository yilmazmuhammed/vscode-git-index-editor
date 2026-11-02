import * as vscode from 'vscode';
import { trackActiveDiff } from './activeDiff';
import { registerCommands } from './commands';
import { onDidChangeDiffMode } from './diffMode';
import { ObjectFileSystem } from './objectFileSystem';
import { RepositoryManager } from './repository';
import { HEAD_SCHEME, INDEX_SCHEME } from './uris';

export function activate(context: vscode.ExtensionContext): { manager: RepositoryManager } {
	const log = vscode.window.createOutputChannel('Git Index Editor', { log: true });
	const manager = new RepositoryManager(log);
	const isCaseSensitive = process.platform === 'linux';

	const indexFileSystem = new ObjectFileSystem(manager, INDEX_SCHEME);
	const headFileSystem = new ObjectFileSystem(manager, HEAD_SCHEME);
	context.subscriptions.push(
		log,
		manager,
		vscode.workspace.registerFileSystemProvider(INDEX_SCHEME, indexFileSystem, { isCaseSensitive }),
		vscode.workspace.registerFileSystemProvider(HEAD_SCHEME, headFileSystem, { isCaseSensitive, isReadonly: true }),
		manager.onDidChange(repository => {
			Promise.all([indexFileSystem.refresh(repository), headFileSystem.refresh(repository)])
				.catch(error => log.error(error));
		}),
		onDidChangeDiffMode(() => indexFileSystem.reloadOpenDocuments()),
		registerCommands(manager, indexFileSystem, log),
		trackActiveDiff()
	);
	return { manager };
}

export function deactivate(): void { }
