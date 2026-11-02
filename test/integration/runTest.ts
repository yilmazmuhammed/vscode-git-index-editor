import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

const DEBUG_PORT = 9334;

/**
 * The tests move focus between the sides of a diff, and a window that is not in the foreground
 * gets no focus events. This makes the test window behave as focused whatever else is on screen.
 */
async function emulateWindowFocus(): Promise<void> {
	for (let attempt = 0; attempt < 240; attempt++) {
		await new Promise(resolve => setTimeout(resolve, 250));
		try {
			const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json() as { type: string; url: string; webSocketDebuggerUrl: string }[];
			const workbench = targets.find(target => target.type === 'page' && target.url.includes('workbench'));
			if (workbench) {
				const socket = new WebSocket(workbench.webSocketDebuggerUrl);
				socket.addEventListener('open', () => socket.send(JSON.stringify({
					id: 1, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true }
				})));
				return;
			}
		} catch {
			// the window is not up yet
		}
	}
}

async function main(): Promise<void> {
	const repository = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'index-editor-it-'));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: repository });
	git('init', '-q', '-b', 'main');
	git('config', 'user.name', 'Test');
	git('config', 'user.email', 'test@example.com');
	git('config', 'core.autocrlf', 'false');
	fs.writeFileSync(path.join(repository, '.gitkeep'), '');
	git('add', '.');
	git('commit', '-q', '-m', 'first');

	void emulateWindowFocus();
	await runTests({
		// Set VSCODE_EXECUTABLE to test with an installed build instead of downloading one.
		vscodeExecutablePath: process.env.VSCODE_EXECUTABLE,
		version: process.env.VSCODE_VERSION,
		extensionDevelopmentPath: path.resolve(__dirname, '../../..'),
		extensionTestsPath: path.resolve(__dirname, 'suite'),
		launchArgs: [
			repository, '--disable-workspace-trust', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
			`--remote-debugging-port=${DEBUG_PORT}`
		]
	});
	process.exit(0);
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
