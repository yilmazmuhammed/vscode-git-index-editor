import * as vscode from 'vscode';
import { ActiveDiff, activeDiff, diffShowing } from './activeDiff';
import { isEmptyUri } from './uris';

/** `workbench.action.focusFirstEditorGroup` and so on, by view column. */
const FOCUS_GROUP_COMMANDS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth']
	.map(nth => `workbench.action.focus${nth}EditorGroup`);

const isMarkdownPreview = (tab: vscode.Tab | undefined): boolean =>
	tab?.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('markdown.preview');

const previewCount = (): number =>
	vscode.window.tabGroups.all.reduce((count, group) => count + group.tabs.filter(isMarkdownPreview).length, 0);

/** The group that shows `diff` now; groups move to other view columns as groups open and close. */
function groupOf(diff: ActiveDiff): vscode.TabGroup | undefined {
	const index = diff.index.toString();
	return vscode.window.tabGroups.all.find(group => group.tabs.some(tab =>
		tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === index));
}

async function focus(group: vscode.TabGroup | undefined): Promise<void> {
	const command = group && FOCUS_GROUP_COMMANDS[group.viewColumn - 1];
	if (command && !group.isActive) {
		await vscode.commands.executeCommand(command);
	}
}

/** Resolves when `condition` holds after a change of the tabs, or after `timeout` milliseconds. */
function tabsSettle(condition: () => boolean, timeout = 1500): Promise<void> {
	return new Promise(resolve => {
		if (condition()) {
			resolve();
			return;
		}
		const done = () => {
			clearTimeout(timer);
			listener.dispose();
			resolve();
		};
		const listener = vscode.window.tabGroups.onDidChangeTabs(() => condition() && done());
		const timer = setTimeout(done, timeout);
	});
}

/**
 * Opens a Markdown preview of one side of a diff beside it: the left side (the working tree file or the
 * base) or the Index. The Markdown extension's own button would always preview the right side, which in
 * our diffs is the Index.
 *
 * The preview is locked, so it keeps showing its side when the cursor moves to the other side. When the
 * preview of the other side is already in the group beside, the new one goes below it, so both are
 * visible. The diff gets the focus back, and with it its title buttons.
 */
export async function previewSide(side: 'left' | 'index', args: readonly unknown[]): Promise<void> {
	const [uri] = args;
	const diff = (uri instanceof vscode.Uri ? diffShowing(uri) : undefined) ?? activeDiff();
	if (!diff) {
		return;
	}
	const target = side === 'index' ? diff.index : diff.other;
	if (isEmptyUri(target)) {
		vscode.window.showInformationMessage(vscode.l10n.t('This side of the diff has no file to preview.'));
		return;
	}
	// "To the side" is beside the active group, so make that the diff's group.
	await focus(groupOf(diff));
	const before = previewCount();
	await vscode.commands.executeCommand('markdown.showLockedPreviewToSide', target);
	await tabsSettle(() => previewCount() > before || isMarkdownPreview(vscode.window.tabGroups.activeTabGroup.activeTab));

	const group = vscode.window.tabGroups.activeTabGroup;
	if (previewCount() > before && isMarkdownPreview(group.activeTab) && group.tabs.filter(isMarkdownPreview).length > 1) {
		await vscode.commands.executeCommand('workbench.action.moveEditorToBelowGroup');
	}
	await focus(groupOf(diff));
}
