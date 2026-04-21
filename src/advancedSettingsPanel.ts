import * as vscode from 'vscode';
import { PlayerPreferences, ReaderSettings, SettingsStore } from './settingsStore';

export class AdvancedSettingsPanel {
	private static panel: vscode.WebviewPanel | undefined;

	static show(context: vscode.ExtensionContext, store: SettingsStore): void {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'text-reader.advanced-settings',
			'日本語読み上げ 詳細設定',
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true }
		);
		this.panel = panel;

		panel.webview.html = this.getHtml(panel.webview, store.getSettings());

		panel.webview.onDidReceiveMessage(async (message: unknown) => {
			if (!message || typeof message !== 'object') {
				return;
			}
			const type = (message as Record<string, unknown>).type;
			if (type === 'saveSettings') {
				const payload = (message as Record<string, unknown>).settings as Partial<ReaderSettings> | undefined;
				if (!payload) {
					return;
				}
				const current = store.getSettings();
				const next: ReaderSettings = {
					pauseAsMaEnabled: typeof payload.pauseAsMaEnabled === 'boolean' ? payload.pauseAsMaEnabled : current.pauseAsMaEnabled,
					pauseDurationMs: typeof payload.pauseDurationMs === 'number' ? payload.pauseDurationMs : current.pauseDurationMs,
					skipLinePrefix: typeof payload.skipLinePrefix === 'string' ? payload.skipLinePrefix : current.skipLinePrefix
				};
				await store.saveSettings(next);
				return;
			}

			if (type === 'exportJson') {
				await exportSettingsJson(store);
				panel.webview.postMessage({ type: 'notify', message: 'JSONをエクスポートしました。' });
				return;
			}

			if (type === 'importJson') {
				const imported = await importSettingsJson(store);
				if (!imported) {
					return;
				}
				panel.webview.postMessage({
					type: 'importedSettings',
					settings: imported
				});
				panel.webview.postMessage({ type: 'notify', message: 'JSONをインポートしました。' });
			}
		}, undefined, context.subscriptions);

		panel.onDidDispose(() => {
			if (this.panel === panel) {
				this.panel = undefined;
			}
		}, null, context.subscriptions);
	}

	private static getHtml(webview: vscode.Webview, settings: ReaderSettings): string {
		const nonce = getNonce();
		const cspSource = webview.cspSource;
		return `<!DOCTYPE html>
<html lang="ja">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<title>日本語読み上げ 詳細設定</title>
	<style nonce="${nonce}">
		body {
			font-family: var(--vscode-font-family);
			color: var(--vscode-foreground);
			padding: 16px;
		}
		.section {
			margin-bottom: 20px;
			padding: 12px;
			border: 1px solid var(--vscode-panel-border);
			border-radius: 6px;
			background: var(--vscode-editor-background);
		}
		label {
			display: block;
			margin-bottom: 6px;
			font-size: 12px;
		}
		input[type="number"],
		input[type="text"] {
			width: 100%;
			box-sizing: border-box;
			padding: 7px 8px;
			border: 1px solid var(--vscode-input-border);
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border-radius: 4px;
		}
		.checkbox-row {
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.checkbox-row label {
			margin-bottom: 0;
		}
		.hint {
			font-size: 12px;
			color: var(--vscode-descriptionForeground);
			margin-top: 6px;
		}
		.saved {
			font-size: 12px;
			color: var(--vscode-charts-green);
			height: 18px;
		}
		.json-actions {
			display: flex;
			gap: 8px;
			flex-wrap: wrap;
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
	</style>
</head>
<body>
	<h2>詳細設定</h2>
	<div class="section">
		<div class="checkbox-row">
			<input id="pauseEnabled" type="checkbox" ${settings.pauseAsMaEnabled ? 'checked' : ''}>
			<label for="pauseEnabled">「……」「――」を記号として読まず、間として扱う</label>
		</div>
		<label for="pauseMs">間の時間（ミリ秒）</label>
		<input id="pauseMs" type="number" min="100" max="5000" step="100" value="${settings.pauseDurationMs}">
		<div class="hint">100〜5000ms で設定できます。</div>
	</div>
	<div class="section">
		<label for="skipPrefix">読み上げ除外（行頭記号・カンマ区切り）</label>
		<input id="skipPrefix" type="text" value="${escapeHtml(settings.skipLinePrefix)}" placeholder="#,//,; など">
		<div class="hint">行頭が一致する行を読み飛ばします。複数はカンマ区切りで設定します。</div>
	</div>
	<div class="section">
		<label>設定JSON</label>
		<div class="json-actions">
			<button id="exportJsonBtn">JSONをエクスポート</button>
			<button id="importJsonBtn">JSONをインポート</button>
		</div>
		<div class="hint">詳細設定とユーザー辞書を1つのJSONとして入出力します。</div>
	</div>
	<div id="saved" class="saved"></div>
	<script nonce="${nonce}">
	(function() {
		const vscode = acquireVsCodeApi();
		const pauseEnabled = document.getElementById('pauseEnabled');
		const pauseMs = document.getElementById('pauseMs');
		const skipPrefix = document.getElementById('skipPrefix');
		const exportJsonBtn = document.getElementById('exportJsonBtn');
		const importJsonBtn = document.getElementById('importJsonBtn');
		const saved = document.getElementById('saved');
		let timer = null;

		function flash(text) {
			saved.textContent = text;
			if (timer) {
				clearTimeout(timer);
			}
			timer = setTimeout(() => {
				saved.textContent = '';
			}, 1400);
		}

		function save() {
			const ms = Math.max(100, Math.min(5000, parseInt(pauseMs.value || '500', 10)));
			pauseMs.value = String(ms);
			vscode.postMessage({
				type: 'saveSettings',
				settings: {
					pauseAsMaEnabled: pauseEnabled.checked,
					pauseDurationMs: ms,
					skipLinePrefix: skipPrefix.value
				}
			});
			flash('自動保存しました');
		}

		pauseEnabled.addEventListener('change', save);
		pauseMs.addEventListener('change', save);
		skipPrefix.addEventListener('input', save);
		exportJsonBtn.addEventListener('click', function() {
			vscode.postMessage({ type: 'exportJson' });
		});
		importJsonBtn.addEventListener('click', function() {
			vscode.postMessage({ type: 'importJson' });
		});

		window.addEventListener('message', function(event) {
			const message = event.data;
			if (message.type === 'importedSettings' && message.settings) {
				pauseEnabled.checked = !!message.settings.pauseAsMaEnabled;
				pauseMs.value = String(message.settings.pauseDurationMs || 500);
				skipPrefix.value = message.settings.skipLinePrefix || '';
			}
			if (message.type === 'notify' && message.message) {
				flash(message.message);
			}
		});
	})();
	</script>
</body>
</html>`;
	}
}

interface ExportPayload {
	formatVersion: number;
	settings: ReaderSettings;
	playerPreferences: PlayerPreferences;
	userDictionary: Array<{ kanji: string; reading: string }>;
}

async function exportSettingsJson(store: SettingsStore): Promise<void> {
	const payload: ExportPayload = {
		formatVersion: 1,
		settings: store.getSettings(),
		playerPreferences: store.getPlayerPreferences(),
		userDictionary: store.getDictionary()
	};
	const uri = await vscode.window.showSaveDialog({
		title: '設定JSONをエクスポート',
		saveLabel: 'エクスポート',
		filters: { JSON: ['json'] },
		defaultUri: vscode.Uri.file('text-reader-settings.json')
	});
	if (!uri) {
		return;
	}
	const content = JSON.stringify(payload, null, 2);
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
}

async function importSettingsJson(store: SettingsStore): Promise<ReaderSettings | undefined> {
	const picked = await vscode.window.showOpenDialog({
		title: '設定JSONをインポート',
		openLabel: 'インポート',
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		filters: { JSON: ['json'] }
	});
	const uri = picked?.[0];
	if (!uri) {
		return undefined;
	}

	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		const text = new TextDecoder().decode(bytes);
		const raw = JSON.parse(text) as unknown;
		const parsed = parseImportPayload(raw);
		await store.saveSettings(parsed.settings);
		await store.savePlayerPreferences(parsed.playerPreferences);
		await store.saveDictionary(parsed.userDictionary);
		return parsed.settings;
	} catch {
		vscode.window.showErrorMessage('インポートに失敗しました。JSON形式を確認してください。');
		return undefined;
	}
}

function parseImportPayload(raw: unknown): ExportPayload {
	if (!raw || typeof raw !== 'object') {
		throw new Error('invalid payload');
	}
	const obj = raw as Record<string, unknown>;
	const settingsSource = (obj.settings ?? obj) as Record<string, unknown>;
	const settings: ReaderSettings = {
		pauseAsMaEnabled: typeof settingsSource.pauseAsMaEnabled === 'boolean' ? settingsSource.pauseAsMaEnabled : true,
		pauseDurationMs: sanitizePauseDuration(settingsSource.pauseDurationMs),
		skipLinePrefix: typeof settingsSource.skipLinePrefix === 'string' ? settingsSource.skipLinePrefix : ''
	};
	const playerSource = (obj.playerPreferences ?? {}) as Record<string, unknown>;
	const playerPreferences: PlayerPreferences = {
		speed: sanitizeSpeed(playerSource.speed),
		volume: sanitizeVolume(playerSource.volume),
		voiceURI: typeof playerSource.voiceURI === 'string' ? playerSource.voiceURI : ''
	};
	const dictionaryRaw = Array.isArray(obj.userDictionary) ? obj.userDictionary : [];
	const userDictionary = dictionaryRaw
		.filter((row) => row && typeof row === 'object')
		.map((row) => ({
			kanji: String((row as Record<string, unknown>).kanji ?? '').trim(),
			reading: String((row as Record<string, unknown>).reading ?? '').trim()
		}))
		.filter((row) => Boolean(row.kanji) && Boolean(row.reading));

	return {
		formatVersion: typeof obj.formatVersion === 'number' ? obj.formatVersion : 1,
		settings,
		playerPreferences,
		userDictionary
	};
}

function sanitizePauseDuration(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return 500;
	}
	return Math.max(100, Math.min(5000, Math.round(value)));
}

function sanitizeSpeed(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return 1.0;
	}
	return Math.max(1.0, Math.min(5.0, value));
}

function sanitizeVolume(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return 100;
	}
	return Math.max(0, Math.min(100, Math.round(value)));
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
