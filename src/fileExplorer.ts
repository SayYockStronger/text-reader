import * as vscode from 'vscode';

export class FileExplorerProvider implements vscode.TreeDataProvider<FileItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<FileItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private _onDidSelectFile = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidSelectFile = this._onDidSelectFile.event;

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: FileItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: FileItem): Promise<FileItem[]> {
		if (!vscode.workspace.workspaceFolders) {
			return [];
		}

		const uri = element ? element.resourceUri : vscode.workspace.workspaceFolders[0].uri;
		const entries = await vscode.workspace.fs.readDirectory(uri);

		const items: FileItem[] = [];

		// Sort: folders first, then files, alphabetically
		entries.sort((a, b) => {
			if (a[1] === b[1]) {
				return a[0].localeCompare(b[0]);
			}
			return a[1] === vscode.FileType.Directory ? -1 : 1;
		});

		for (const [name, type] of entries) {
			if (name.startsWith('.')) {
				continue;
			}
			const childUri = vscode.Uri.joinPath(uri, name);
			if (type === vscode.FileType.Directory) {
				items.push(new FileItem(
					name,
					childUri,
					vscode.TreeItemCollapsibleState.Collapsed,
					true
				));
			} else {
				items.push(new FileItem(
					name,
					childUri,
					vscode.TreeItemCollapsibleState.None,
					false
				));
			}
		}

		return items;
	}

	selectFile(uri: vscode.Uri): void {
		this._onDidSelectFile.fire(uri);
	}
}

export class FileItem extends vscode.TreeItem {
	constructor(
		public readonly label: string,
		public readonly resourceUri: vscode.Uri,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly isDirectory: boolean
	) {
		super(label, collapsibleState);

		if (!isDirectory) {
			this.command = {
				command: 'text-reader.openFile',
				title: 'ファイルを開く',
				arguments: [resourceUri]
			};
			this.contextValue = 'file';
		} else {
			this.contextValue = 'folder';
		}
	}
}
