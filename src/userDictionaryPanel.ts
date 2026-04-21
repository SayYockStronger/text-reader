import * as vscode from 'vscode';
import { SettingsStore, UserDictionaryEntry } from './settingsStore';

export class UserDictionaryPanel {
	private static panel: vscode.WebviewPanel | undefined;

	static show(context: vscode.ExtensionContext, store: SettingsStore): void {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'text-reader.user-dictionary',
			'日本語読み上げ ユーザー辞書',
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true }
		);
		this.panel = panel;

		panel.webview.html = this.getHtml(panel.webview, store.getDictionary());

		panel.webview.onDidReceiveMessage(async (message: unknown) => {
			if (!message || typeof message !== 'object') {
				return;
			}
			const type = (message as Record<string, unknown>).type;
			if (type !== 'saveDictionary') {
				return;
			}
			const rows = (message as Record<string, unknown>).entries;
			if (!Array.isArray(rows)) {
				return;
			}
			const entries: UserDictionaryEntry[] = rows
				.filter((row) => row && typeof row === 'object')
				.map((row) => ({
					kanji: String((row as Record<string, unknown>).kanji ?? ''),
					reading: String((row as Record<string, unknown>).reading ?? '')
				}));
			await store.saveDictionary(entries);
		}, undefined, context.subscriptions);

		panel.onDidDispose(() => {
			if (this.panel === panel) {
				this.panel = undefined;
			}
		}, null, context.subscriptions);
	}

	private static getHtml(webview: vscode.Webview, entries: UserDictionaryEntry[]): string {
		const nonce = getNonce();
		const cspSource = webview.cspSource;
		const initialJson = JSON.stringify(entries).replace(/</g, '\\u003c');
		return `<!DOCTYPE html>
<html lang="ja">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<title>日本語読み上げ ユーザー辞書</title>
	<style nonce="${nonce}">
		body {
			font-family: var(--vscode-font-family);
			color: var(--vscode-foreground);
			padding: 16px;
		}
		.top-bar {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 10px;
		}
		button {
			padding: 6px 10px;
			border: none;
			border-radius: 4px;
			cursor: pointer;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		button:hover {
			background: var(--vscode-button-hoverBackground);
		}
		table {
			width: 100%;
			border-collapse: collapse;
		}
		th, td {
			border-bottom: 1px solid var(--vscode-panel-border);
			padding: 6px;
			text-align: left;
		}
		th {
			font-weight: 600;
		}
		input[type="text"] {
			width: 100%;
			box-sizing: border-box;
			padding: 6px 8px;
			border: 1px solid var(--vscode-input-border);
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border-radius: 4px;
		}
		.delete-btn {
			width: 28px;
			height: 28px;
			padding: 0;
			font-size: 16px;
			line-height: 1;
			text-align: center;
		}
		.saved {
			font-size: 12px;
			color: var(--vscode-charts-green);
			height: 18px;
		}
	</style>
</head>
<body>
	<div class="top-bar">
		<h2>ユーザー辞書</h2>
		<button id="addRowBtn">行を追加</button>
	</div>
	<table>
		<thead>
			<tr>
				<th style="width: 45%;">漢字</th>
				<th style="width: 45%;">読み</th>
				<th style="width: 10%;">×</th>
			</tr>
		</thead>
		<tbody id="rows"></tbody>
	</table>
	<div id="saved" class="saved"></div>

	<script nonce="${nonce}">
	(function() {
		const vscode = acquireVsCodeApi();
		const initialEntries = ${initialJson};
		const rowsEl = document.getElementById('rows');
		const savedEl = document.getElementById('saved');
		let timer = null;

		function createRow(kanji, reading) {
			const tr = document.createElement('tr');
			tr.innerHTML =
				'<td><input type="text" class="kanji" value="' + escapeHtml(kanji) + '"></td>' +
				'<td><input type="text" class="reading" value="' + escapeHtml(reading) + '"></td>' +
				'<td><button class="delete-btn" title="削除">×</button></td>';

			const kanjiInput = tr.querySelector('.kanji');
			const readingInput = tr.querySelector('.reading');
			const deleteBtn = tr.querySelector('.delete-btn');

			kanjiInput.addEventListener('input', save);
			readingInput.addEventListener('input', save);
			deleteBtn.addEventListener('click', function() {
				tr.remove();
				save();
			});
			rowsEl.appendChild(tr);
		}

		function save() {
			const entries = [];
			for (const tr of rowsEl.querySelectorAll('tr')) {
				const kanji = tr.querySelector('.kanji').value;
				const reading = tr.querySelector('.reading').value;
				entries.push({ kanji: kanji, reading: reading });
			}
			vscode.postMessage({ type: 'saveDictionary', entries: entries });
			savedEl.textContent = '自動保存しました';
			if (timer) {
				clearTimeout(timer);
			}
			timer = setTimeout(function() {
				savedEl.textContent = '';
			}, 1200);
		}

		function escapeHtml(str) {
			const div = document.createElement('div');
			div.textContent = str;
			return div.innerHTML;
		}

		for (const row of initialEntries) {
			createRow(row.kanji, row.reading);
		}
		if (initialEntries.length === 0) {
			createRow('', '');
		}

		document.getElementById('addRowBtn').addEventListener('click', function() {
			createRow('', '');
			save();
		});
	})();
	</script>
</body>
</html>`;
	}
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
