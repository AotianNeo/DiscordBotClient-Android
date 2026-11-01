import { awaitStorage, createStorage, preloadStorageIfExists } from "@lib/api/storage";
import { DEFAULT_SETTINGS_PROTO_1, DEFAULT_SETTINGS_PROTO_2 } from "./constants";

export interface SavedBotAccount {
    id: string;
    username: string;
    discriminator: string;
    globalName?: string | null;
    avatar: string | null;
    token: string;
    currentShard: number;
    allShards: number;
    applicationFlags: number;
    intents: number;
    guildCount: number;
    bio?: string;
    addedAt: number;
}

export interface BotClientStorageSchema {
    botClientMode: boolean;
    currentBotId: string;
    currentToken: string;
    currentShard: number;
    allShards: number;
    guildsPerShard: number;
    showMemberList: boolean;
    memberListThrottleDelay: number;
    saveDirectMessage: boolean;
    generateFakeProfile: boolean;
    spoofNitro: boolean;
    bots: Record<string, SavedBotAccount>;
    privateChannels: Record<string, Record<string, any>>;
    settingsProto1: string;
    settingsProto2: string;
}

export const defaultBotClientStorage: BotClientStorageSchema = {
    botClientMode: true,
    currentBotId: "",
    currentToken: "",
    currentShard: 0,
    allShards: 1,
    guildsPerShard: 1000,
    showMemberList: true,
    memberListThrottleDelay: 2000,
    saveDirectMessage: true,
    generateFakeProfile: true,
    spoofNitro: true,
    bots: {},
    privateChannels: {},
    settingsProto1: DEFAULT_SETTINGS_PROTO_1,
    settingsProto2: DEFAULT_SETTINGS_PROTO_2
};

const BOTCLIENT_STORAGE_PATH = "plugins/storage/bunny.botclient.json";

let _rawStorage: BotClientStorageSchema | null = null;
const _fallbackMemoryStorage: BotClientStorageSchema = JSON.parse(
    JSON.stringify(defaultBotClientStorage)
);

export function initBotClientStorage(): BotClientStorageSchema {
    if (_rawStorage) return _rawStorage;
    try {
        _rawStorage = createStorage<BotClientStorageSchema>(
            BOTCLIENT_STORAGE_PATH,
            {
                dflt: JSON.parse(JSON.stringify(defaultBotClientStorage))
            }
        );
        return _rawStorage;
    } catch {
        return _fallbackMemoryStorage;
    }
}

export async function awaitBotClientStorage(): Promise<void> {
    try {
        await preloadStorageIfExists(BOTCLIENT_STORAGE_PATH);
        const raw = initBotClientStorage();
        if (raw && raw !== _fallbackMemoryStorage) {
            await awaitStorage(raw);
        }
    } catch {
        // Fallback to in-memory storage when native FS is unavailable (e.g., Bun unit tests)
    }
}

export const botStorage: BotClientStorageSchema = new Proxy(_fallbackMemoryStorage, {
    get(target, prop: keyof BotClientStorageSchema) {
        try {
            if (_rawStorage) {
                const val = _rawStorage[prop];
                if (val !== undefined) return val;
            }
        } catch {
            // Storage not yet resolved from disk; fall back to in-memory default
        }
        return target[prop];
    },
    set(target, prop: keyof BotClientStorageSchema, value: any) {
        (target as any)[prop] = value;
        try {
            if (_rawStorage) {
                (_rawStorage as any)[prop] = value;
            }
        } catch {
            // Ignore before async storage init completes
        }
        return true;
    }
});

/**
 * Strips any leading "Bot " prefix and whitespace from a token.
 */
export function cleanBotToken(token: string | null | undefined): string {
    if (!token || typeof token !== "string") return "";
    return token.trim().replace(/^Bot\s+/i, "").trim();
}

/**
 * Formats a token with the required "Bot " prefix for Discord HTTP REST API calls.
 */
export function formatBotAuthHeader(token: string | null | undefined): string {
    const clean = cleanBotToken(token);
    if (!clean) return "";
    return `Bot ${clean}`;
}

/**
 * Save or update a Bot account in persistent storage
 */
export function saveBotAccount(account: SavedBotAccount): void {
    const bots = { ...(botStorage.bots || {}) };
    bots[account.id] = account;
    botStorage.bots = bots;
    botStorage.currentBotId = account.id;
    botStorage.currentToken = cleanBotToken(account.token);
    botStorage.currentShard = account.currentShard;
    botStorage.allShards = account.allShards;
}

/**
 * Remove a saved Bot account
 */
export function removeBotAccount(botId: string): void {
    const bots = { ...(botStorage.bots || {}) };
    delete bots[botId];
    botStorage.bots = bots;
    if (botStorage.currentBotId === botId) {
        const remaining = Object.keys(bots);
        if (remaining.length > 0) {
            const next = bots[remaining[0]];
            botStorage.currentBotId = next.id;
            botStorage.currentToken = next.token;
            botStorage.currentShard = next.currentShard;
            botStorage.allShards = next.allShards;
        } else {
            botStorage.currentBotId = "";
            botStorage.currentToken = "";
        }
    }
}

/**
 * Save a DM / PrivateChannel record for a specific bot
 */
export function savePrivateChannel(botId: string, channelId: string, channelData: any): void {
    if (!botStorage.saveDirectMessage || !botId || !channelId) return;
    const allPrivate = { ...(botStorage.privateChannels || {}) };
    const botChannels = { ...(allPrivate[botId] || {}) };
    botChannels[channelId] = channelData;
    allPrivate[botId] = botChannels;
    botStorage.privateChannels = allPrivate;
}

/**
 * Delete a saved DM / PrivateChannel record for a specific bot
 */
export function deletePrivateChannel(botId: string, channelId: string): void {
    if (!botId || !channelId) return;
    const allPrivate = { ...(botStorage.privateChannels || {}) };
    if (allPrivate[botId]) {
        const botChannels = { ...allPrivate[botId] };
        delete botChannels[channelId];
        allPrivate[botId] = botChannels;
        botStorage.privateChannels = allPrivate;
    }
}

/**
 * Get all saved DM channels for a specific bot
 */
export function getSavedPrivateChannels(botId: string): Record<string, any> {
    if (!botId) return {};
    return botStorage.privateChannels?.[botId] ?? {};
}

// Runtime cache for application emojis fetched on login
export let runtimeApplicationEmojis: any[] = [];
export function setRuntimeApplicationEmojis(emojis: any[]) {
    runtimeApplicationEmojis = Array.isArray(emojis) ? emojis : [];
}
