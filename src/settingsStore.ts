import * as vscode from 'vscode';

export interface ReaderSettings {
	pauseAsMaEnabled: boolean;
	pauseDurationMs: number;
	skipLinePrefix: string;
}

export interface UserDictionaryEntry {
	kanji: string;
	reading: string;
}

export interface PlayerPreferences {
	speed: number;
	volume: number;
	voiceURI: string;
}

const SETTINGS_KEY = 'text-reader.advancedSettings';
const USER_DICTIONARY_KEY = 'text-reader.userDictionary';
const PLAYER_PREFERENCES_KEY = 'text-reader.playerPreferences';

const DEFAULT_SETTINGS: ReaderSettings = {
	pauseAsMaEnabled: true,
	pauseDurationMs: 500,
	skipLinePrefix: ''
};

const DEFAULT_PLAYER_PREFERENCES: PlayerPreferences = {
	speed: 1.0,
	volume: 100,
	voiceURI: ''
};

export class SettingsStore {
	constructor(private readonly context: vscode.ExtensionContext) {}

	getSettings(): ReaderSettings {
		const raw = this.context.globalState.get<Partial<ReaderSettings> | undefined>(SETTINGS_KEY);
		if (!raw) {
			return { ...DEFAULT_SETTINGS };
		}
		return {
			pauseAsMaEnabled: typeof raw.pauseAsMaEnabled === 'boolean' ? raw.pauseAsMaEnabled : DEFAULT_SETTINGS.pauseAsMaEnabled,
			pauseDurationMs: sanitizePauseDuration(raw.pauseDurationMs),
			skipLinePrefix: typeof raw.skipLinePrefix === 'string' ? raw.skipLinePrefix : DEFAULT_SETTINGS.skipLinePrefix
		};
	}

	async saveSettings(next: ReaderSettings): Promise<void> {
		const normalized: ReaderSettings = {
			pauseAsMaEnabled: next.pauseAsMaEnabled,
			pauseDurationMs: sanitizePauseDuration(next.pauseDurationMs),
			skipLinePrefix: next.skipLinePrefix ?? ''
		};
		await this.context.globalState.update(SETTINGS_KEY, normalized);
	}

	getDictionary(): UserDictionaryEntry[] {
		const raw = this.context.globalState.get<unknown>(USER_DICTIONARY_KEY);
		if (!Array.isArray(raw)) {
			return [];
		}
		const entries: UserDictionaryEntry[] = [];
		for (const row of raw) {
			if (!row || typeof row !== 'object') {
				continue;
			}
			const maybeKanji = (row as Record<string, unknown>).kanji;
			const maybeReading = (row as Record<string, unknown>).reading;
			if (typeof maybeKanji !== 'string' || typeof maybeReading !== 'string') {
				continue;
			}
			const kanji = maybeKanji.trim();
			const reading = maybeReading.trim();
			if (!kanji || !reading) {
				continue;
			}
			entries.push({ kanji, reading });
		}
		return entries;
	}

	async saveDictionary(entries: UserDictionaryEntry[]): Promise<void> {
		const normalized = entries
			.map((entry) => ({
				kanji: entry.kanji.trim(),
				reading: entry.reading.trim()
			}))
			.filter((entry) => Boolean(entry.kanji) && Boolean(entry.reading));
		await this.context.globalState.update(USER_DICTIONARY_KEY, normalized);
	}

	getPlayerPreferences(): PlayerPreferences {
		const raw = this.context.globalState.get<Partial<PlayerPreferences> | undefined>(PLAYER_PREFERENCES_KEY);
		if (!raw) {
			return { ...DEFAULT_PLAYER_PREFERENCES };
		}
		return {
			speed: sanitizeSpeed(raw.speed),
			volume: sanitizeVolume(raw.volume),
			voiceURI: typeof raw.voiceURI === 'string' ? raw.voiceURI : DEFAULT_PLAYER_PREFERENCES.voiceURI
		};
	}

	async savePlayerPreferences(next: PlayerPreferences): Promise<void> {
		const normalized: PlayerPreferences = {
			speed: sanitizeSpeed(next.speed),
			volume: sanitizeVolume(next.volume),
			voiceURI: next.voiceURI ?? ''
		};
		await this.context.globalState.update(PLAYER_PREFERENCES_KEY, normalized);
	}
}

function sanitizePauseDuration(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return DEFAULT_SETTINGS.pauseDurationMs;
	}
	return Math.max(100, Math.min(5000, Math.round(value)));
}

function sanitizeSpeed(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return DEFAULT_PLAYER_PREFERENCES.speed;
	}
	return Math.max(1.0, Math.min(5.0, value));
}

function sanitizeVolume(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return DEFAULT_PLAYER_PREFERENCES.volume;
	}
	return Math.max(0, Math.min(100, Math.round(value)));
}
