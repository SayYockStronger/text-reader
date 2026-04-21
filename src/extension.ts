import * as vscode from 'vscode';
import { ReaderViewProvider } from './readerPanel';
import { FileExplorerProvider } from './fileExplorer';
import { initTokenizer, isTokenizerReady } from './tokenizer';
import { AdvancedSettingsPanel } from './advancedSettingsPanel';
import { SettingsStore } from './settingsStore';
import { UserDictionaryPanel } from './userDictionaryPanel';

export function activate(context: vscode.ExtensionContext) {
	// インストール・更新後に再読み込みを促す
	const ext = vscode.extensions.getExtension('text-reader.text-reader');
	const currentVersion = ext?.packageJSON?.version as string | undefined ?? context.extension.packageJSON.version as string;
	const lastVersion = context.globalState.get<string>('text-reader.lastVersion');
	if (currentVersion && lastVersion !== currentVersion) {
		context.globalState.update('text-reader.lastVersion', currentVersion);
		vscode.window.showInformationMessage(
			'日本語読み上げ がインストール/更新されました。ウィンドウを再読み込みしてください。',
			'再読み込み'
		).then(selected => {
			if (selected === '再読み込み') {
				vscode.commands.executeCommand('workbench.action.reloadWindow');
			}
		});
	}

	// kuromoji 辞書を非同期に初期化
	initTokenizer(context.extensionPath).then(() => {
		vscode.window.setStatusBarMessage('日本語読み上げ: 辞書を読み込みました', 3000);
	}).catch(err => {
		vscode.window.showWarningMessage(`日本語読み上げ: 辞書の読み込みに失敗しました: ${err.message}`);
	});

	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'text-reader.pauseResume';
	statusBarItem.text = '$(unmute) 日本語読み上げ';
	statusBarItem.tooltip = 'テキスト読み上げ';
	context.subscriptions.push(statusBarItem);

	const settingsStore = new SettingsStore(context);

	const provider = new ReaderViewProvider(context, statusBarItem, {
		getSettings: () => settingsStore.getSettings(),
		getDictionary: () => settingsStore.getDictionary(),
		getPlayerPreferences: () => settingsStore.getPlayerPreferences(),
		savePlayerPreferences: (next) => settingsStore.savePlayerPreferences(next),
		onOpenAdvancedSettings: () => AdvancedSettingsPanel.show(context, settingsStore),
		onOpenUserDictionary: () => UserDictionaryPanel.show(context, settingsStore)
	});
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ReaderViewProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);

	const fileExplorer = new FileExplorerProvider();
	const treeView = vscode.window.createTreeView('text-reader.files', {
		treeDataProvider: fileExplorer,
		showCollapseAll: true
	});
	context.subscriptions.push(treeView);

	treeView.onDidChangeSelection(async (e) => {
		const item = e.selection[0];
		if (item && !item.isDirectory) {
			try {
				const content = await vscode.workspace.fs.readFile(item.resourceUri);
				const text = new TextDecoder('utf-8').decode(content);
				if (text.trim()) {
					provider.setSelectedFile(item.resourceUri.fsPath, text);
				}
			} catch {
				// ignore
			}
		}
	});

	context.subscriptions.push(
		vscode.commands.registerCommand('text-reader.selectFile', async (uri: vscode.Uri) => {
			try {
				const content = await vscode.workspace.fs.readFile(uri);
				const text = new TextDecoder('utf-8').decode(content);
				if (!text.trim()) {
					vscode.window.showWarningMessage('ファイルが空です。');
					return;
				}
				provider.setSelectedFile(uri.fsPath, text);
			} catch {
				vscode.window.showWarningMessage('ファイルを読み込めませんでした。');
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('text-reader.openFile', async (uri: vscode.Uri) => {
			try {
				const doc = await vscode.workspace.openTextDocument(uri);
				await vscode.window.showTextDocument(doc, { preview: false });
			} catch {
				vscode.window.showWarningMessage('ファイルを開けませんでした。');
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('text-reader.refreshFiles', () => {
			fileExplorer.refresh();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('text-reader.openAdvancedSettings', () => {
			AdvancedSettingsPanel.show(context, settingsStore);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('text-reader.openUserDictionary', () => {
			UserDictionaryPanel.show(context, settingsStore);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('text-reader.readAll', () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showWarningMessage('アクティブなエディタがありません。');
				return;
			}
			const text = editor.document.getText();
			if (!text.trim()) {
				vscode.window.showWarningMessage('ファイルが空です。');
				return;
			}
			provider.read(text);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('text-reader.readFromCursor', () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showWarningMessage('アクティブなエディタがありません。');
				return;
			}
			const document = editor.document;
			const lineStart = document.lineAt(editor.selection.active.line).range.start;
			const cursorOffset = document.offsetAt(lineStart);
			const text = document.getText().substring(cursorOffset);
			if (!text.trim()) {
				vscode.window.showWarningMessage('カーソル位置以降にテキストがありません。');
				return;
			}
			provider.read(text);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('text-reader.pauseResume', () => {
			provider.pauseResume();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('text-reader.stop', () => {
			provider.stop();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('text-reader.setSpeed', async () => {
			const speeds = ['1.0', '2.0', '3.0', '4.0', '5.0'];
			const picked = await vscode.window.showQuickPick(speeds, {
				placeHolder: '読み上げ速度を選択してください'
			});
			if (picked) {
				provider.setSpeed(parseFloat(picked));
			}
		})
	);
}

export function deactivate() {}
