import * as vscode from 'vscode';
import { convertToReading } from './tokenizer';

export class ReaderViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'text-reader.view';

	private view?: vscode.WebviewView;
	private statusBarItem: vscode.StatusBarItem;
	private speed: number = 1.0;
	private lastEditor: vscode.TextEditor | undefined;
	private editorListener: vscode.Disposable;
	private selectedFileText: string | undefined;
	private selectedFilePath: string | undefined;

	constructor(private readonly context: vscode.ExtensionContext, statusBarItem: vscode.StatusBarItem) {
		this.statusBarItem = statusBarItem;

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
					break;
				case 'requestReadAll':
					this.handleReadRequest('all');
					break;
				case 'requestReadFromCursor':
					this.handleReadRequest('cursor');
					break;
			}
		});

		this.statusBarItem.show();
	}

	read(text: string) {
		const converted = convertToReading(text);
		this.view?.webview.postMessage({ type: 'read', text: converted, originalText: text, speed: this.speed });
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
			const converted = convertToReading(text);
			this.view?.webview.postMessage({ type: 'read', text: converted, originalText: text, speed: this.speed });
			return;
		}
		// Prefer selected file from explorer, fallback to active editor
		if (this.selectedFileText) {
			const text = this.selectedFileText;
			if (!text.trim()) {
				vscode.window.showWarningMessage('読み上げるテキストがありません。');
				return;
			}
			const converted = convertToReading(text);
			this.view?.webview.postMessage({ type: 'read', text: converted, originalText: text, speed: this.speed });
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
		const convertedAll = convertToReading(allText);
		this.view?.webview.postMessage({ type: 'read', text: convertedAll, originalText: allText, speed: this.speed });
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
				this.statusBarItem.text = '$(unmute) Text Reader';
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
		body {
			padding: 12px;
			font-family: var(--vscode-font-family);
			color: var(--vscode-foreground);
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
	</style>
</head>
<body>
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
			<option value="1.25">1.25x</option>
			<option value="1.5">1.5x</option>
			<option value="1.75">1.75x</option>
			<option value="2">2.0x</option>
			<option value="2.25">2.25x</option>
			<option value="2.5">2.5x</option>
			<option value="2.75">2.75x</option>
			<option value="3">3.0x</option>
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
			if (prevValue && prevValue < jaVoices.length) {
				voiceEl.value = prevValue;
			}
			jaVoice = jaVoices[parseInt(voiceEl.value)] || null;
		}

		loadVoices();
		if (synthAvailable && speechSynthesis.onvoiceschanged !== undefined) {
			speechSynthesis.addEventListener('voiceschanged', loadVoices);
		}

		voiceEl.addEventListener('change', function() {
			jaVoice = jaVoices[parseInt(voiceEl.value)] || null;
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
			text = text.replace(/\u2026/g, '');
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

		function splitText(text) {
			const lines = text.split(/\\n/);
			const result = [];
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed) {
					result.push(trimmed);
				}
			}
			return result.length > 0 ? result : [text.trim()];
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
				textPreviewEl.textContent = displayChunks[currentIndex];
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

		function startReading(text, originalText, speed) {
			generation++;
			currentSpeed = speed;
			speedEl.value = String(speed);
			chunks = splitText(preprocessText(text));
			displayChunks = splitText(originalText || text);
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
					startReading(message.text, message.originalText, message.speed);
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
