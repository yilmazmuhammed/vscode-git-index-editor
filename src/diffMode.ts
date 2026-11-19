import * as vscode from 'vscode';

const SECTION = 'diffEditor';
const SETTING = 'renderSideBySide';

/**
 * The Index editors work only in side-by-side diffs. An inline diff has no Index pane to edit
 * and no gutter arrow to stage with, so while inline is on the Index stays read-only.
 */
export function isInlineDiff(): boolean {
	return vscode.workspace.getConfiguration(SECTION).get(SETTING) === false;
}

export function onDidChangeDiffMode(listener: () => void): vscode.Disposable {
	return vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(`${SECTION}.${SETTING}`)) {
			listener();
		}
	});
}

/** Offers to leave inline mode. Resolves to whether diffs are side by side now. */
export async function ensureSideBySide(): Promise<boolean> {
	if (!isInlineDiff()) {
		return true;
	}
	const useSideBySide = vscode.l10n.t('Use Side-by-Side');
	const answer = await vscode.window.showInformationMessage(
		vscode.l10n.t('The Index can be edited only in the side-by-side diff view.'),
		useSideBySide
	);
	if (answer === useSideBySide) {
		await vscode.workspace.getConfiguration(SECTION).update(SETTING, true, vscode.ConfigurationTarget.Global);
	}
	return !isInlineDiff();
}
