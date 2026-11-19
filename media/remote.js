// @ts-check
/* The remote configuration editor. Talks to RemoteEditors (src/repositories/remoteEditor.ts). */
(function () {
	// @ts-ignore acquireVsCodeApi is provided by the webview host
	const vscode = acquireVsCodeApi();
	/** @type {Record<string, string>} */
	// @ts-ignore set by the page
	const t = window.INDEX_EDITOR_STRINGS;

	/** @template {keyof HTMLElementTagNameMap} K */
	function el(/** @type {K} */ tag, /** @type {Record<string, string>} */ attributes = {}, /** @type {(Node|string)[]} */ children = []) {
		const node = document.createElement(tag);
		for (const [key, value] of Object.entries(attributes)) {
			node.setAttribute(key, value);
		}
		node.append(...children);
		return node;
	}

	function field(/** @type {string} */ id, /** @type {string} */ label, /** @type {string} */ hint, /** @type {HTMLElement} */ input) {
		return el('div', { class: 'field' }, [
			el('label', { for: id }, [label]),
			input,
			el('div', { class: 'hint' }, [hint])
		]);
	}

	function select(/** @type {string} */ id, /** @type {[string, string][]} */ options) {
		return el('select', { id }, options.map(([value, label]) => el('option', { value }, [label])));
	}

	const url = el('input', { type: 'text', id: 'url', spellcheck: 'false' });
	const pushUrls = el('textarea', { id: 'pushUrls', rows: '2', spellcheck: 'false' });
	const fetchSpecs = el('textarea', { id: 'fetchSpecs', rows: '3', spellcheck: 'false' });
	const pushSpecs = el('textarea', { id: 'pushSpecs', rows: '2', spellcheck: 'false' });
	const tags = select('tags', [['', t.tagsAuto], ['--tags', t.tagsAll], ['--no-tags', t.tagsNone]]);
	const prune = select('prune', [['', t.pruneDefault], ['true', t.pruneYes], ['false', t.pruneNo]]);
	const result = el('div', { class: 'result', hidden: '' });

	const buttons = /** @type {const} */ ([
		['dryRun', t.dryRun, 'secondary'],
		['push', t.savePush, 'secondary'],
		['fetch', t.saveFetch, 'secondary'],
		['none', t.save, '']
	]).map(([then, label, kind]) => {
		const button = el('button', { type: 'button', class: kind }, [label]);
		button.addEventListener('click', () => save(then));
		return button;
	});

	const title = el('h2');
	document.body.append(el('div', { class: 'form remote' }, [
		title,
		field('url', t.url, t.urlHint, url),
		field('pushUrls', t.pushUrls, t.pushUrlsHint, pushUrls),
		field('fetchSpecs', t.fetchSpecs, t.fetchSpecsHint, fetchSpecs),
		field('pushSpecs', t.pushSpecs, t.pushSpecsHint, pushSpecs),
		field('tags', t.tags, '', tags),
		field('prune', t.prune, '', prune),
		result,
		el('div', { class: 'buttons' }, buttons)
	]));

	const lines = (/** @type {string} */ text) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	/** @type {any} */
	let remote;

	function save(/** @type {string} */ then) {
		if (!remote) {
			return;
		}
		vscode.postMessage({
			type: 'save',
			then,
			remote: {
				name: remote.name,
				url: url.value.trim(),
				pushUrls: lines(pushUrls.value),
				fetch: lines(fetchSpecs.value),
				push: lines(pushSpecs.value),
				tagOpt: tags.value,
				prune: prune.value
			}
		});
	}

	window.addEventListener('message', event => {
		const data = event.data;
		switch (data.type) {
			case 'state':
				remote = data.remote;
				title.textContent = remote.name;
				url.value = remote.url;
				pushUrls.value = remote.pushUrls.join('\n');
				fetchSpecs.value = remote.fetch.join('\n');
				pushSpecs.value = remote.push.join('\n');
				tags.value = remote.tagOpt;
				prune.value = remote.prune;
				break;
			case 'result':
				result.hidden = false;
				result.textContent = data.message;
				result.classList.toggle('error', !data.ok);
				break;
			case 'busy':
				for (const button of buttons) {
					button.disabled = data.busy;
				}
				break;
		}
	});

	vscode.postMessage({ type: 'ready' });
})();
