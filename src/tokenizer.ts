import * as kuromoji from 'kuromoji';
import * as path from 'path';

let tokenizer: kuromoji.Tokenizer<kuromoji.IpadicFeatures> | null = null;
let initPromise: Promise<void> | null = null;

/**
 * kuromoji トークナイザーを初期化する。
 * 辞書は node_modules/kuromoji/dict から読み込む。
 */
export function initTokenizer(extensionPath: string): Promise<void> {
	if (tokenizer) { return Promise.resolve(); }
	if (initPromise) { return initPromise; }

	const dicPath = path.join(extensionPath, 'node_modules', 'kuromoji', 'dict');

	initPromise = new Promise<void>((resolve, reject) => {
		kuromoji.builder({ dicPath: dicPath + path.sep }).build((err, built) => {
			if (err) {
				initPromise = null;
				reject(err);
			} else {
				tokenizer = built;
				resolve();
			}
		});
	});

	return initPromise;
}

export function isTokenizerReady(): boolean {
	return tokenizer !== null;
}

const kanjiRegex = /[\u4e00-\u9faf\u3400-\u4dbf\u{20000}-\u{2a6df}]/u;

/**
 * テキスト中の漢字を含むトークンを読み仮名（カタカナ）に変換する。
 * 漢字を含まないトークン（ひらがな・カタカナ・記号・数字等）はそのまま返す。
 */
export function convertToReading(text: string): string {
	if (!tokenizer) { return text; }

	return text.split('\n').map(line => {
		if (!line.trim()) { return line; }

		const tokens = tokenizer!.tokenize(line);
		return tokens.map(token => {
			if (token.reading && kanjiRegex.test(token.surface_form)) {
				return token.reading;
			}
			return token.surface_form;
		}).join('');
	}).join('\n');
}
