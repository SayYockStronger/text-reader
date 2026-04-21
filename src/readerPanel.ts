import * as vscode from 'vscode';
import { convertToReading } from './tokenizer';
import { PlayerPreferences, ReaderSettings, UserDictionaryEntry } from './settingsStore';

interface ReaderViewDependencies {
	getSettings: () => ReaderSettings;
	getDictionary: () => UserDictionaryEntry[];
	getPlayerPreferences: () => PlayerPreferences;
	savePlayerPreferences: (next: PlayerPreferences) => Promise<void>;
	onOpenAdvancedSettings: () => void;
	onOpenUserDictionary: () => void;
}

export class ReaderViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'text-reader.view';

	private view?: vscode.WebviewView;
	private statusBarItem: vscode.StatusBarItem;
	private speed: number = 1.0;
	private lastEditor: vscode.TextEditor | undefined;
	private editorListener: vscode.Disposable;
	private selectedFileText: string | undefined;
	private selectedFilePath: string | undefined;
	private voiceURI: string = '';
	private volume: number = 100;

	constructor(
		private readonly context: vscode.ExtensionContext,
		statusBarItem: vscode.StatusBarItem,
		private readonly deps: ReaderViewDependencies
	) {
		this.statusBarItem = statusBarItem;
		const prefs = this.deps.getPlayerPreferences();
		this.speed = prefs.speed;
		this.volume = prefs.volume;
		this.voiceURI = prefs.voiceURI;

		this.lastEditor = vscode.window.activeTextEditor;
		this.editorListener = vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor) {
				this.lastEditor = editor;
			}
		});
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		this.view = webviewView;

		webviewView.webview.options = {
			enableScripts: true
		};

		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(message => {
			switch (message.type) {
				case 'stateChange':
					this.updateStatusBar(message.state);
					break;
				case 'speedChanged':
					this.speed = message.speed;
					void this.persistPlayerPreferences();
					break;
				case 'volumeChanged':
					this.volume = message.volume;
					void this.persistPlayerPreferences();
					break;
				case 'voiceChanged':
					this.voiceURI = message.voiceURI;
					void this.persistPlayerPreferences();
					break;
				case 'requestReadAll':
					this.handleReadRequest('all');
					break;
				case 'requestReadFromCursor':
					this.handleReadRequest('cursor');
					break;
				case 'openAdvancedSettings':
					this.deps.onOpenAdvancedSettings();
					break;
				case 'openUserDictionary':
					this.deps.onOpenUserDictionary();
					break;
			}
		});

		webviewView.webview.postMessage({
			type: 'initializePlayerPreferences',
			speed: this.speed,
			volume: this.volume,
			voiceURI: this.voiceURI
		});

		this.statusBarItem.show();
	}

	read(text: string) {
		const prepared = this.prepareText(text);
		const settings = this.deps.getSettings();
		this.view?.webview.postMessage({
			type: 'read',
			text: prepared.converted,
			originalText: prepared.original,
			speed: this.speed,
			pauseAsMaEnabled: settings.pauseAsMaEnabled,
			pauseDurationMs: settings.pauseDurationMs
		});
	}

	pauseResume() {
		this.view?.webview.postMessage({ type: 'pauseResume' });
	}

	stop() {
		this.view?.webview.postMessage({ type: 'stop' });
	}

	setSpeed(speed: number) {
		this.speed = speed;
		this.view?.webview.postMessage({ type: 'setSpeed', speed });
		void this.persistPlayerPreferences();
	}

	setSelectedFile(filePath: string, text: string) {
		this.selectedFilePath = filePath;
		this.selectedFileText = text;
		const name = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
		this.view?.webview.postMessage({ type: 'fileSelected', name });
	}

	dispose() {
		this.editorListener.dispose();
	}

	private handleReadRequest(mode: 'all' | 'cursor') {
		// For cursor mode, always use the active editor's cursor position
		if (mode === 'cursor') {
			const editor = vscode.window.activeTextEditor || this.lastEditor;
			if (!editor) {
				vscode.window.showWarningMessage('カーソル位置を取得できません。エディタでファイルを開いてください。');
				return;
			}
			const lineStart = editor.document.lineAt(editor.selection.active.line).range.start;
			const cursorOffset = editor.document.offsetAt(lineStart);
			const text = editor.document.getText().substring(cursorOffset);
			if (!text.trim()) {
				vscode.window.showWarningMessage('読み上げるテキストがありません。');
				return;
			}
			const prepared = this.prepareText(text);
			const settings = this.deps.getSettings();
			this.view?.webview.postMessage({
				type: 'read',
				text: prepared.converted,
				originalText: prepared.original,
				speed: this.speed,
				pauseAsMaEnabled: settings.pauseAsMaEnabled,
				pauseDurationMs: settings.pauseDurationMs
			});
			return;
		}
		// Prefer selected file from explorer, fallback to active editor
		if (this.selectedFileText) {
			const text = this.selectedFileText;
			if (!text.trim()) {
				vscode.window.showWarningMessage('読み上げるテキストがありません。');
				return;
			}
			const prepared = this.prepareText(text);
			const settings = this.deps.getSettings();
			this.view?.webview.postMessage({
				type: 'read',
				text: prepared.converted,
				originalText: prepared.original,
				speed: this.speed,
				pauseAsMaEnabled: settings.pauseAsMaEnabled,
				pauseDurationMs: settings.pauseDurationMs
			});
			return;
		}
		const editor = vscode.window.activeTextEditor || this.lastEditor;
		if (!editor) {
			vscode.window.showWarningMessage('ファイルを選択してください。');
			return;
		}
		const allText = editor.document.getText();
		if (!allText.trim()) {
			vscode.window.showWarningMessage('読み上げるテキストがありません。');
			return;
		}
		const prepared = this.prepareText(allText);
		const settings = this.deps.getSettings();
		this.view?.webview.postMessage({
			type: 'read',
			text: prepared.converted,
			originalText: prepared.original,
			speed: this.speed,
			pauseAsMaEnabled: settings.pauseAsMaEnabled,
			pauseDurationMs: settings.pauseDurationMs
		});
	}

	private prepareText(input: string): { original: string; converted: string } {
		const settings = this.deps.getSettings();
		const filtered = this.filterExcludedLines(input, settings.skipLinePrefix);
		const dictionaryApplied = this.applyUserDictionary(filtered, this.deps.getDictionary());
		const replaced = convertToReading(dictionaryApplied);
		return {
			original: filtered,
			converted: replaced
		};
	}

	private filterExcludedLines(text: string, prefix: string): string {
		const prefixes = prefix
			.split(',')
			.map((part) => part.trim())
			.filter((part) => Boolean(part));
		if (prefixes.length === 0) {
			return text;
		}
		const lines = text
			.split('\n')
			.filter((line) => !prefixes.some((item) => line.startsWith(item)));
		return lines.join('\n');
	}

	private applyUserDictionary(text: string, entries: UserDictionaryEntry[]): string {
		let result = text;
		for (const entry of entries) {
			if (!entry.kanji || !entry.reading) {
				continue;
			}
			result = result.split(entry.kanji).join(entry.reading);
		}
		return result;
	}

	private async persistPlayerPreferences(): Promise<void> {
		await this.deps.savePlayerPreferences({
			speed: this.speed,
			volume: this.volume,
			voiceURI: this.voiceURI
		});
	}

	private updateStatusBar(state: string) {
		switch (state) {
			case 'reading':
				this.statusBarItem.text = '$(megaphone) 読み上げ中...';
				this.statusBarItem.tooltip = 'クリックで一時停止/再開';
				break;
			case 'paused':
				this.statusBarItem.text = '$(debug-pause) 一時停止';
				this.statusBarItem.tooltip = 'クリックで再開';
				break;
			case 'stopped':
				this.statusBarItem.text = '$(unmute) 日本語読み上げ';
				this.statusBarItem.tooltip = 'テキスト読み上げ';
				break;
		}
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const cspSource = webview.cspSource;
		return /*html*/`<!DOCTYPE html>
<html lang="ja">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<style nonce="${nonce}">
		html, body {
			height: 100%;
		}
		body {
			padding: 12px;
			box-sizing: border-box;
			font-family: var(--vscode-font-family);
			color: var(--vscode-foreground);
			display: flex;
			flex-direction: column;
			margin: 0;
			overflow: hidden;
		}
		.main-content {
			overflow-y: auto;
			padding-right: 2px;
		}
		.status {
			font-size: 13px;
			margin: 8px 0;
			padding: 6px 10px;
			border-radius: 4px;
			background: var(--vscode-textBlockQuote-background);
			border-left: 3px solid var(--vscode-textBlockQuote-border);
		}
		.status.reading {
			border-left-color: var(--vscode-charts-green);
		}
		.status.paused {
			border-left-color: var(--vscode-charts-yellow);
		}
		.controls {
			display: flex;
			gap: 6px;
			align-items: center;
			margin: 8px 0;
			flex-wrap: wrap;
		}
		button {
			padding: 5px 10px;
			border: none;
			border-radius: 4px;
			cursor: pointer;
			font-size: 12px;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			white-space: nowrap;
		}
		button:hover:not(:disabled) {
			background: var(--vscode-button-hoverBackground);
		}
		button:disabled {
			opacity: 0.5;
			cursor: default;
		}
		select {
			padding: 4px 6px;
			border: 1px solid var(--vscode-dropdown-border);
			border-radius: 4px;
			background: var(--vscode-dropdown-background);
			color: var(--vscode-dropdown-foreground);
			font-size: 12px;
		}
		.volume-row {
			display: flex;
			align-items: center;
			gap: 6px;
			margin: 8px 0;
		}
		.volume-row input[type="range"] {
			flex: 1;
			height: 4px;
			-webkit-appearance: none;
			appearance: none;
			background: var(--vscode-scrollbarSlider-background);
			border-radius: 2px;
			outline: none;
		}
		.volume-row input[type="range"]::-webkit-slider-thumb {
			-webkit-appearance: none;
			appearance: none;
			width: 12px;
			height: 12px;
			border-radius: 50%;
			background: var(--vscode-button-background);
			cursor: pointer;
		}
		.volume-value {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			min-width: 32px;
			text-align: right;
		}
		.progress {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			margin: 6px 0;
		}
		.label {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			margin-bottom: 4px;
		}
		.selected-file {
			font-size: 12px;
			padding: 6px 10px;
			margin: 8px 0;
			border-radius: 4px;
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			color: var(--vscode-foreground);
		}
		.selected-file .filename {
			font-weight: 600;
		}
		.text-preview {
			margin-top: 8px;
			padding: 8px;
			border-radius: 4px;
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			font-size: 12px;
			line-height: 1.5;
			max-height: 200px;
			overflow-y: auto;
			white-space: pre-wrap;
			word-wrap: break-word;
		}
		.footer-actions {
			margin-top: auto;
			padding-top: 10px;
			display: flex;
			gap: 6px;
			flex-wrap: wrap;
			border-top: 1px solid var(--vscode-panel-border);
			background: var(--vscode-sideBar-background);
		}
	</style>
</head>
<body>
	<div class="main-content">
		<div id="selectedFile" class="selected-file">ファイル未選択（左のエクスプローラーから選択）</div>
		<div class="controls">
			<button id="readAllBtn">最初から読み上げ</button>
			<button id="readFromCursorBtn">カーソルから読み上げ</button>
		</div>
		<div id="status" class="status">待機中</div>
		<div class="controls">
			<button id="pauseResumeBtn" disabled>一時停止</button>
			<button id="stopBtn" disabled>停止</button>
			<button id="prevBtn" disabled>◀ 前の行</button>
			<button id="nextBtn" disabled>次の行 ▶</button>
		</div>
		<div class="controls">
			<label class="label" for="voiceSelect">音声:</label>
			<select id="voiceSelect"><option value="">読み込み中...</option></select>
		</div>
		<div class="controls">
			<label class="label" for="speedSelect">速度:</label>
			<select id="speedSelect">
				<option value="1">1.0x</option>
				<option value="2">2.0x</option>
				<option value="3">3.0x</option>
				<option value="4">4.0x</option>
				<option value="5">5.0x</option>
			</select>
		</div>
		<div class="volume-row">
			<label class="label" for="volumeRange">音量:</label>
			<input type="range" id="volumeRange" min="0" max="100" value="100" step="1">
			<span id="volumeValue" class="volume-value">100%</span>
		</div>
		<div id="progress" class="progress"></div>
		<div class="label">読み上げ中のテキスト:</div>
		<div id="textPreview" class="text-preview"></div>
	</div>
	<div class="footer-actions">
		<button id="openAdvancedSettingsBtn">詳細設定</button>
		<button id="openUserDictionaryBtn">ユーザー辞書</button>
	</div>
	<script nonce="${nonce}">
	(function() {
		const vscode = acquireVsCodeApi();

		let chunks = [];
		let displayChunks = [];
		let currentIndex = 0;
		let isSpeaking = false;
		let isPaused = false;
		let currentSpeed = 1.0;
		let generation = 0;
		let jaVoice = null;
		let jaVoices = [];
		let currentVolume = 1.0;
		let currentUtterance = null;
		let pauseAsMaEnabled = true;
		let pauseDurationMs = 500;
		let preferredVoiceURI = '';

		const statusEl = document.getElementById('status');
		const speedEl = document.getElementById('speedSelect');
		const voiceEl = document.getElementById('voiceSelect');
		const pauseBtn = document.getElementById('pauseResumeBtn');
		const stopBtn = document.getElementById('stopBtn');
		const prevBtn = document.getElementById('prevBtn');
		const nextBtn = document.getElementById('nextBtn');
		const progressEl = document.getElementById('progress');
		const textPreviewEl = document.getElementById('textPreview');
		const selectedFileEl = document.getElementById('selectedFile');
		const volumeRange = document.getElementById('volumeRange');
		const volumeValueEl = document.getElementById('volumeValue');

		var synthAvailable = (typeof speechSynthesis !== 'undefined');

		function loadVoices() {
			if (!synthAvailable) {
				voiceEl.innerHTML = '<option value="">音声合成が利用できません</option>';
				return;
			}
			var voices = [];
			try { voices = speechSynthesis.getVoices(); } catch(e) { synthAvailable = false; }
			if (!synthAvailable) {
				voiceEl.innerHTML = '<option value="">音声合成が利用できません</option>';
				return;
			}
			jaVoices = voices.filter(v => v.lang === 'ja-JP' || v.lang.startsWith('ja'));
			if (jaVoices.length === 0) {
				jaVoices = voices;
			}
			if (jaVoices.length === 0) {
				voiceEl.innerHTML = '<option value="">音声が見つかりません</option>';
				jaVoice = null;
				return;
			}
			var prevValue = voiceEl.value;
			voiceEl.innerHTML = '';
			for (var i = 0; i < jaVoices.length; i++) {
				var opt = document.createElement('option');
				opt.value = String(i);
				opt.textContent = jaVoices[i].name;
				voiceEl.appendChild(opt);
			}
			if (preferredVoiceURI) {
				var preferredIndex = -1;
				for (var j = 0; j < jaVoices.length; j++) {
					if (jaVoices[j].voiceURI === preferredVoiceURI) {
						preferredIndex = j;
						break;
					}
				}
				if (preferredIndex >= 0) {
					voiceEl.value = String(preferredIndex);
				}
			} else if (prevValue && parseInt(prevValue, 10) < jaVoices.length) {
				voiceEl.value = prevValue;
			}
			var selectedIndex = parseInt(voiceEl.value, 10);
			if (Number.isNaN(selectedIndex)) {
				selectedIndex = 0;
				voiceEl.value = '0';
			}
			jaVoice = jaVoices[selectedIndex] || null;
			if (jaVoice) {
				preferredVoiceURI = jaVoice.voiceURI || '';
			}
		}

		loadVoices();
		if (synthAvailable && speechSynthesis.onvoiceschanged !== undefined) {
			speechSynthesis.addEventListener('voiceschanged', loadVoices);
		}

		voiceEl.addEventListener('change', function() {
			var selectedIndex = parseInt(voiceEl.value, 10);
			jaVoice = jaVoices[selectedIndex] || null;
			preferredVoiceURI = jaVoice && jaVoice.voiceURI ? jaVoice.voiceURI : '';
			vscode.postMessage({ type: 'voiceChanged', voiceURI: preferredVoiceURI });
		});

		function preprocessText(text) {
			// URLを「リンク」に置換
			text = text.replace(/https?:[/][/][^ \t\u3000\u300c\u300d]+/g, '\u30ea\u30f3\u30af');
			// メールアドレス
			text = text.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+[.][a-zA-Z]{2,}/g, '\u30e1\u30fc\u30eb\u30a2\u30c9\u30ec\u30b9');

			// 単位付き数値
			text = text.replace(/([0-9]+)%/g, '$1\u30d1\u30fc\u30bb\u30f3\u30c8');
			text = text.replace(/([0-9]+)km/gi, '$1\u30ad\u30ed\u30e1\u30fc\u30c8\u30eb');
			text = text.replace(/([0-9]+)cm/gi, '$1\u30bb\u30f3\u30c1\u30e1\u30fc\u30c8\u30eb');
			text = text.replace(/([0-9]+)mm/gi, '$1\u30df\u30ea\u30e1\u30fc\u30c8\u30eb');
			text = text.replace(/([0-9]+)kg/gi, '$1\u30ad\u30ed\u30b0\u30e9\u30e0');
			text = text.replace(/([0-9]+)mg/gi, '$1\u30df\u30ea\u30b0\u30e9\u30e0');
			text = text.replace(/([0-9]+)g(?![a-zA-Z])/g, '$1\u30b0\u30e9\u30e0');
			text = text.replace(/([0-9]+)m(?![a-zA-Z])/g, '$1\u30e1\u30fc\u30c8\u30eb');
			text = text.replace(/([0-9]+)GB/gi, '$1\u30ae\u30ac\u30d0\u30a4\u30c8');
			text = text.replace(/([0-9]+)MB/gi, '$1\u30e1\u30ac\u30d0\u30a4\u30c8');
			text = text.replace(/([0-9]+)KB/gi, '$1\u30ad\u30ed\u30d0\u30a4\u30c8');
			text = text.replace(/([0-9]+)TB/gi, '$1\u30c6\u30e9\u30d0\u30a4\u30c8');

			// 記号の読み替え
			text = text.replace(/\u2192/g, '');
			text = text.replace(/\u2190/g, '');
			text = text.replace(/\u2191/g, '');
			text = text.replace(/\u2193/g, '');
			text = text.replace(/\u203b/g, '');
			text = text.replace(/\u301c/g, '');
			text = text.replace(/&/g, '\u30a2\u30f3\u30c9');
			text = text.replace(/#/g, '\u30ca\u30f3\u30d0\u30fc');
			text = text.replace(/[+]/g, '\u30d7\u30e9\u30b9');
			text = text.replace(/=/g, '\u30a4\u30b3\u30fc\u30eb');

			// 括弧類の除去
			text = text.replace(/[\u300c\u300d\u300e\u300f\u3010\u3011\uff08\uff09()[\]{}]/g, ' ');

			// 連続空白を整理
			text = text.replace(/ {2,}/g, ' ');

			return text;
		}

		function splitText(text, enablePause, pauseMs) {
			const lines = text.split(/\\n/);
			const result = [];
			const pauseToken = '__TR_PAUSE_' + pauseMs + '__';
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed) {
					if (!enablePause) {
						result.push(trimmed);
						continue;
					}
					const marked = trimmed.replace(/(……+|――+)/g, '__TR_PAUSE__');
					const parts = marked.split('__TR_PAUSE__');
					for (let i = 0; i < parts.length; i++) {
						const part = parts[i].trim();
						if (part) {
							result.push(part);
						}
						if (i < parts.length - 1) {
							result.push(pauseToken);
						}
					}
				}
			}
			return result.length > 0 ? result : [text.trim()];
		}

		function isPauseToken(chunk) {
			return /^__TR_PAUSE_[0-9]+__$/.test(chunk);
		}

		function getPauseDuration(chunk) {
			const matched = chunk.match(/^__TR_PAUSE_([0-9]+)__$/);
			if (!matched) {
				return pauseDurationMs;
			}
			return parseInt(matched[1], 10);
		}

		function updateUI(state) {
			vscode.postMessage({ type: 'stateChange', state: state });

			switch (state) {
				case 'reading':
					statusEl.textContent = '読み上げ中...';
					statusEl.className = 'status reading';
					pauseBtn.textContent = '一時停止';
					pauseBtn.disabled = false;
					stopBtn.disabled = false;
					prevBtn.disabled = false;
					nextBtn.disabled = false;
					break;
				case 'paused':
					statusEl.textContent = '一時停止';
					statusEl.className = 'status paused';
					pauseBtn.textContent = '再開';
					pauseBtn.disabled = false;
					stopBtn.disabled = false;
					prevBtn.disabled = false;
					nextBtn.disabled = false;
					break;
				case 'stopped':
					statusEl.textContent = '待機中';
					statusEl.className = 'status';
					pauseBtn.textContent = '一時停止';
					pauseBtn.disabled = true;
					stopBtn.disabled = true;
					prevBtn.disabled = true;
					nextBtn.disabled = true;
					break;
			}
		}

		function updateProgress() {
			if (chunks.length > 0) {
				progressEl.textContent = (currentIndex + 1) + ' / ' + chunks.length;
			} else {
				progressEl.textContent = '';
			}
			if (currentIndex < displayChunks.length) {
				if (isPauseToken(displayChunks[currentIndex])) {
					textPreviewEl.textContent = '（間）';
				} else {
					textPreviewEl.textContent = displayChunks[currentIndex];
				}
			} else {
				textPreviewEl.textContent = '';
			}
		}

		function cancelAndWaitReady(callback) {
			if (!synthAvailable) { callback(); return; }
			speechSynthesis.cancel();
			if (!speechSynthesis.speaking) {
				callback();
				return;
			}
			var attempts = 0;
			function poll() {
				if (!speechSynthesis.speaking || attempts >= 20) {
					callback();
				} else {
					attempts++;
					setTimeout(poll, 10);
				}
			}
			setTimeout(poll, 10);
		}

		function speakNext() {
			const gen = generation;

			if (currentIndex >= chunks.length) {
				isSpeaking = false;
				isPaused = false;
				updateUI('stopped');
				progressEl.textContent = '';
				textPreviewEl.textContent = '読み上げ完了';
				return;
			}

			if (!synthAvailable) {
				statusEl.textContent = 'エラー: 音声合成が利用できません';
				statusEl.className = 'status';
				isSpeaking = false;
				return;
			}

			if (isPauseToken(chunks[currentIndex])) {
				const delay = getPauseDuration(chunks[currentIndex]);
				setTimeout(function() {
					if (gen !== generation) {
						return;
					}
					currentIndex++;
					updateProgress();
					speakNext();
				}, delay);
				return;
			}

			const utterance = new SpeechSynthesisUtterance(chunks[currentIndex]);
			utterance.lang = 'ja-JP';
			utterance.rate = currentSpeed;
			utterance.volume = currentVolume;
			if (jaVoice) {
				utterance.voice = jaVoice;
			}
			currentUtterance = utterance;

			var settled = false;
			var speakTimeout = null;

			utterance.onstart = function() {
				if (speakTimeout) { clearTimeout(speakTimeout); speakTimeout = null; }
			};

			utterance.onend = function() {
				if (settled || gen !== generation) { return; }
				settled = true;
				if (speakTimeout) { clearTimeout(speakTimeout); }
				currentUtterance = null;
				currentIndex++;
				updateProgress();
				speakNext();
			};

			utterance.onerror = function(e) {
				if (settled || gen !== generation) { return; }
				settled = true;
				if (speakTimeout) { clearTimeout(speakTimeout); }
				if (e.error !== 'canceled' && e.error !== 'interrupted') {
					currentIndex++;
					updateProgress();
					speakNext();
				}
			};

			try {
				speechSynthesis.speak(utterance);
			} catch(e) {
				statusEl.textContent = 'エラー: 音声再生に失敗しました';
				statusEl.className = 'status';
				isSpeaking = false;
				return;
			}

			// Timeout: if onstart doesn't fire within 3s, skip to next chunk
			speakTimeout = setTimeout(function() {
				if (settled || gen !== generation) { return; }
				settled = true;
				currentUtterance = null;
				// Try to cancel the stuck utterance
				try { speechSynthesis.cancel(); } catch(e) {}
				currentIndex++;
				updateProgress();
				if (currentIndex < chunks.length) {
					speakNext();
				} else {
					isSpeaking = false;
					isPaused = false;
					updateUI('stopped');
					textPreviewEl.textContent = '読み上げ完了';
				}
			}, 3000);

			updateProgress();
		}

		function startReading(text, originalText, speed, enablePauseAsMa, pauseMs) {
			generation++;
			currentSpeed = speed;
			pauseAsMaEnabled = enablePauseAsMa;
			pauseDurationMs = pauseMs;
			speedEl.value = String(speed);
			chunks = splitText(preprocessText(text), pauseAsMaEnabled, pauseDurationMs);
			displayChunks = splitText(originalText || text, pauseAsMaEnabled, pauseDurationMs);
			currentIndex = 0;
			isSpeaking = true;
			isPaused = false;
			updateUI('reading');
			cancelAndWaitReady(function() { speakNext(); });
		}

		function togglePauseResume() {
			if (!isSpeaking || !synthAvailable) { return; }

			if (isPaused) {
				speechSynthesis.resume();
				isPaused = false;
				updateUI('reading');
			} else {
				speechSynthesis.pause();
				isPaused = true;
				updateUI('paused');
			}
		}

		function stopReading() {
			generation++;
			isSpeaking = false;
			isPaused = false;
			if (synthAvailable) { try { speechSynthesis.cancel(); } catch(e) {} }
			updateUI('stopped');
			textPreviewEl.textContent = '';
		}

		window.addEventListener('message', function(event) {
			var message = event.data;
			switch (message.type) {
				case 'read':
					startReading(
						message.text,
						message.originalText,
						message.speed,
						message.pauseAsMaEnabled,
						message.pauseDurationMs
					);
					break;
				case 'pauseResume':
					togglePauseResume();
					break;
				case 'stop':
					stopReading();
					break;
				case 'setSpeed':
					currentSpeed = message.speed;
					speedEl.value = String(message.speed);
					break;
				case 'initializePlayerPreferences':
					currentSpeed = message.speed;
					speedEl.value = String(message.speed);
					var volume = parseInt(String(message.volume), 10);
					if (Number.isNaN(volume)) {
						volume = 100;
					}
					volume = Math.max(0, Math.min(100, volume));
					currentVolume = volume / 100;
					volumeRange.value = String(volume);
					volumeValueEl.textContent = String(volume) + '%';
					preferredVoiceURI = message.voiceURI || '';
					loadVoices();
					break;
				case 'fileSelected':
					selectedFileEl.innerHTML = '\u9078\u629e\u4e2d: <span class=\"filename\">' + escapeHtml(message.name) + '</span>';
					break;
			}
		});

		function escapeHtml(str) {
			var div = document.createElement('div');
			div.textContent = str;
			return div.innerHTML;
		}

		document.getElementById('readAllBtn').addEventListener('click', function() {
			vscode.postMessage({ type: 'requestReadAll' });
		});
		document.getElementById('readFromCursorBtn').addEventListener('click', function() {
			vscode.postMessage({ type: 'requestReadFromCursor' });
		});
		pauseBtn.addEventListener('click', function() { togglePauseResume(); });
		stopBtn.addEventListener('click', function() { stopReading(); });
		prevBtn.addEventListener('click', function() {
			if (!isSpeaking || currentIndex <= 0) { return; }
			currentIndex = Math.max(0, currentIndex - 1);
			isPaused = false;
			generation++;
			cancelAndWaitReady(function() {
				updateUI('reading');
				speakNext();
			});
		});
		nextBtn.addEventListener('click', function() {
			if (!isSpeaking || currentIndex >= chunks.length - 1) { return; }
			currentIndex = Math.min(chunks.length - 1, currentIndex + 1);
			isPaused = false;
			generation++;
			cancelAndWaitReady(function() {
				updateUI('reading');
				speakNext();
			});
		});
		speedEl.addEventListener('change', function() {
			currentSpeed = parseFloat(speedEl.value);
			vscode.postMessage({ type: 'speedChanged', speed: currentSpeed });
		});
		volumeRange.addEventListener('input', function() {
			currentVolume = parseInt(volumeRange.value) / 100;
			volumeValueEl.textContent = volumeRange.value + '%';
			vscode.postMessage({ type: 'volumeChanged', volume: parseInt(volumeRange.value, 10) });
		});
		document.getElementById('openAdvancedSettingsBtn').addEventListener('click', function() {
			vscode.postMessage({ type: 'openAdvancedSettings' });
		});
		document.getElementById('openUserDictionaryBtn').addEventListener('click', function() {
			vscode.postMessage({ type: 'openUserDictionary' });
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
