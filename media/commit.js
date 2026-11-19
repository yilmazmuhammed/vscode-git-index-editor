// @ts-check
/* The Staging view's commit area. Talks to CommitViewProvider (src/staging/commitView.ts). */
(function () {
	// @ts-ignore acquireVsCodeApi is provided by the webview host
	const vscode = acquireVsCodeApi();
	/** @type {Record<string, string>} */
	// @ts-ignore set by the page
	const t = window.EGIT_STRINGS;
	const format = (/** @type {string} */ text, /** @type {unknown[]} */ ...args) =>
		text.replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)]));

	/** @template {keyof HTMLElementTagNameMap} K */
	function el(/** @type {K} */ tag, /** @type {Record<string, string>} */ attributes = {}, /** @type {(Node|string)[]} */ children = []) {
		const node = document.createElement(tag);
		for (const [key, value] of Object.entries(attributes)) {
			node.setAttribute(key, value);
		}
		node.append(...children);
		return node;
	}

	const bannerText = el('span');
	const continueButton = el('button', { type: 'button', class: 'secondary' }, [t.continue]);
	const abortButton = el('button', { type: 'button', class: 'secondary' }, [t.abort]);
	const banner = el('div', { class: 'banner', hidden: '' }, [bannerText, el('div', { class: 'actions' }, [continueButton, abortButton])]);

	const historyButton = el('button', { type: 'button', class: 'link', title: t.previous }, [t.previous]);
	const message = el('textarea', { id: 'message', rows: '6', placeholder: t.placeholder, spellcheck: 'true' });
	const hint = el('div', { class: 'hint' });
	const warning = el('div', { class: 'warning', hidden: '' });

	const amend = el('input', { type: 'checkbox', id: 'amend' });
	const signOff = el('input', { type: 'checkbox', id: 'signOff' });
	const author = el('input', { type: 'text', id: 'author', list: 'authorList', spellcheck: 'false' });
	const committer = el('input', { type: 'text', id: 'committer', list: 'committerList', spellcheck: 'false' });
	const authorList = el('datalist', { id: 'authorList' });
	const committerList = el('datalist', { id: 'committerList' });

	const commitAndPush = el('button', { type: 'button', class: 'secondary' }, [t.commitAndPush]);
	const commit = el('button', { type: 'button' }, [t.commit]);
	const noRepository = el('div', { class: 'empty', hidden: '' }, [t.noRepository]);

	const form = el('div', { class: 'form' }, [
		banner,
		el('div', { class: 'heading' }, [el('label', { for: 'message' }, [t.message]), historyButton]),
		message,
		hint,
		el('div', { class: 'options' }, [
			el('label', {}, [amend, ' ', t.amend]),
			el('label', {}, [signOff, ' ', t.signOff])
		]),
		warning,
		el('div', { class: 'people' }, [
			el('label', { for: 'author' }, [t.author]), author,
			el('label', { for: 'committer' }, [t.committer]), committer
		]),
		authorList,
		committerList,
		el('div', { class: 'buttons' }, [commitAndPush, commit])
	]);
	document.body.append(noRepository, form);

	/** @type {any} */
	let state = { repository: undefined, operation: 'none', stagedCount: 0, authorDefault: '', committerDefault: '', authorHistory: [], committerHistory: [], signOffDefault: false };
	/** The message before Amend replaced it with HEAD's, and the text Amend put in. */
	let beforeAmend = /** @type {string | undefined} */ (undefined);
	let amendText = /** @type {string | undefined} */ (undefined);
	let busy = false;

	function fillList(/** @type {HTMLDataListElement} */ list, /** @type {string[]} */ values) {
		list.replaceChildren(...[...new Set(values.filter(Boolean))].map(value => el('option', { value })));
	}

	function render() {
		const hasRepository = !!state.repository;
		noRepository.hidden = hasRepository;
		form.hidden = !hasRepository;

		const operation = state.operation;
		banner.hidden = operation === 'none';
		bannerText.textContent = t[operation] ?? '';
		continueButton.hidden = operation !== 'rebase';
		abortButton.hidden = operation !== 'rebase' && operation !== 'merge';

		const lines = message.value.split(/\r?\n/);
		const summary = lines[0].length;
		hint.textContent = format(summary > 50 ? t.summaryLong : t.summary, summary);
		hint.classList.toggle('long', summary > 50);
		const secondLine = lines.length > 1 && lines[1].trim() !== '';
		hint.textContent += secondLine ? ` • ${t.secondLine}` : '';

		const pushOnly = !amend.checked && !message.value.trim() && state.stagedCount === 0 && operation === 'none';
		commitAndPush.textContent = pushOnly ? t.pushHead : t.commitAndPush;
		commit.disabled = busy || pushOnly;
		commitAndPush.disabled = busy;
		continueButton.disabled = busy;
		abortButton.disabled = busy;
	}

	let draftTimer = /** @type {any} */ (undefined);
	function saveDraft() {
		clearTimeout(draftTimer);
		draftTimer = setTimeout(() => vscode.postMessage({ type: 'draft', message: message.value }), 300);
		vscode.setState({ message: message.value });
	}

	function send(/** @type {boolean} */ push) {
		if (busy) {
			return;
		}
		vscode.postMessage({
			type: 'commit',
			request: {
				message: message.value,
				amend: amend.checked,
				signOff: signOff.checked,
				author: author.value,
				committer: committer.value,
				push
			}
		});
	}

	message.addEventListener('input', () => {
		saveDraft();
		render();
	});
	message.addEventListener('keydown', event => {
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			send(false);
		}
	});
	commit.addEventListener('click', () => send(false));
	commitAndPush.addEventListener('click', () => send(true));
	continueButton.addEventListener('click', () => vscode.postMessage({ type: 'continue' }));
	abortButton.addEventListener('click', () => vscode.postMessage({ type: 'abort' }));
	historyButton.addEventListener('click', () => vscode.postMessage({ type: 'history' }));
	amend.addEventListener('change', () => {
		if (amend.checked) {
			vscode.postMessage({ type: 'amendChanged', checked: true });
		} else {
			if (amendText !== undefined && message.value === amendText) {
				message.value = beforeAmend ?? '';
				saveDraft();
			}
			beforeAmend = amendText = undefined;
			warning.hidden = true;
		}
		render();
	});

	window.addEventListener('message', event => {
		const data = event.data;
		switch (data.type) {
			case 'state': {
				const previous = state;
				state = data.state;
				for (const [input, key] of /** @type {const} */ ([[author, 'authorDefault'], [committer, 'committerDefault']])) {
					if (!input.value || input.value === previous[key]) {
						input.value = state[key];
					}
				}
				fillList(authorList, [state.authorDefault, ...state.authorHistory]);
				fillList(committerList, [state.committerDefault, ...state.committerHistory]);
				render();
				break;
			}
			case 'reset':
				message.value = data.message;
				amend.checked = false;
				signOff.checked = state.signOffDefault;
				author.value = state.authorDefault;
				committer.value = state.committerDefault;
				beforeAmend = amendText = undefined;
				warning.hidden = true;
				vscode.setState({ message: message.value });
				render();
				break;
			case 'setMessage':
				message.value = data.message;
				saveDraft();
				render();
				break;
			case 'amend':
				if (amend.checked) {
					if (!message.value.trim() || message.value === beforeAmend) {
						beforeAmend = message.value;
						amendText = data.message;
						message.value = data.message;
						saveDraft();
					}
					warning.textContent = t.amendPublished;
					warning.hidden = !data.published;
				}
				render();
				break;
			case 'busy':
				busy = data.busy;
				render();
				break;
			case 'submit':
				// the Commit / Commit (Amend) commands
				if (data.amend) {
					amend.checked = true;
				}
				send(false);
				break;
		}
	});

	const saved = vscode.getState();
	if (saved?.message) {
		message.value = saved.message;
	}
	render();
	vscode.postMessage({ type: 'ready' });
})();
