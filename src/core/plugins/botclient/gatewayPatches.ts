import { after, before, instead } from "@lib/api/patcher";
import { logger } from "@lib/utils/logger";
import { findByProps, findByStoreName } from "@metro/wrappers";
import { getActiveBotToken, getBotInfo, rawDiscordBotFetch } from "./apiInterceptor";
import { NITRO_USER_PATCH, SYSTEM_DM_CHANNEL_ID } from "./constants";
import { updateGuildMembersList } from "./memberList";
import {
    botStorage,
    cleanBotToken,
    deletePrivateChannel,
    getSavedPrivateChannels,
    runtimeApplicationEmojis,
    savePrivateChannel,
    setRuntimeApplicationEmojis
} from "./storage";

const DEFAULT_ALL_BOT_INTENTS = 53608447;

let _cachedFluxDispatcher: any = null;

function isMetroModuleZeroReady(): boolean {
    const win = (globalThis as any).window;
    if (!win || typeof win.__r === "undefined") {
        return true;
    }
    return Boolean(win.modules?.[0]?.isInitialized);
}

function getFluxDispatcher(): any {
    if (_cachedFluxDispatcher) return _cachedFluxDispatcher;
    if (!isMetroModuleZeroReady()) return null;
    try {
        _cachedFluxDispatcher = findByProps("_interceptors", "dispatch");
        return _cachedFluxDispatcher;
    } catch {
        return null;
    }
}

function safeShowToast(message: string, iconName = "WarningIcon"): void {
    try {
        const { showToast } = require("@lib/ui/toasts");
        const { findAssetId } = require("@lib/api/assets");
        showToast(message, findAssetId(iconName));
    } catch {}
}

const authOverlayListeners = new Set<() => void>();
let isSwitchingBotToken = false;

export function subscribeBotAuthOverlay(listener: () => void): () => void {
    authOverlayListeners.add(listener);
    return () => {
        authOverlayListeners.delete(listener);
    };
}

export function notifyBotAuthOverlay(): void {
    for (const fn of authOverlayListeners) {
        try {
            fn();
        } catch {}
    }
}

export function isBotSessionAuthenticated(): boolean {
    if (cleanBotToken(botStorage.currentToken)) return true;
    if (!isMetroModuleZeroReady()) return false;
    try {
        const AuthStore = findByStoreName("AuthenticationStore");
        const tok = cleanBotToken(AuthStore?.getToken?.() || "");
        if (tok) return true;
    } catch {}
    try {
        const UserStore = findByStoreName("UserStore");
        if (UserStore?.getCurrentUser?.()?.id) return true;
    } catch {}
    return false;
}

/**
 * Extracts the numeric Snowflake Bot ID encoded in the first Base64 segment of a Discord Bot Token.
 */
export function extractBotIdFromToken(rawToken: string): string {
    const clean = cleanBotToken(rawToken);
    const firstPart = clean.split(".")[0];
    if (!firstPart) return "";
    try {
        const padded = firstPart.replace(/-/g, "+").replace(/_/g, "/");
        const padLen = (4 - (padded.length % 4)) % 4;
        const b64 = padded + "=".repeat(padLen);
        let decoded = "";
        if (typeof globalThis.atob === "function") {
            decoded = globalThis.atob(b64);
        } else if (typeof Buffer !== "undefined") {
            decoded = Buffer.from(b64, "base64").toString("utf8");
        }
        return /^\d{15,22}$/.test(decoded) ? decoded : "";
    } catch {
        return "";
    }
}

/**
 * Normalizes a Bot Gateway `GUILD_CREATE` payload into Discord User-Gateway shape.
 * Bot Gateway sends guild metadata flat at root (`data.properties === undefined`),
 * whereas Discord Android v351011's `GuildStore` requires `data.properties`.
 * Mirrors `discord-archive-client/pages/src/index.ts` (`fullGuild.properties`).
 */
export function patchGuildCreatePayload(data: any): any {
    if (!data || typeof data !== "object" || data.unavailable) return data;

    if (!data.properties) {
        const excludeKeys = new Set([
            "channels",
            "roles",
            "members",
            "presences",
            "voice_states",
            "threads",
            "stage_instances",
            "guild_scheduled_events",
            "emojis",
            "stickers",
            "activity_instances",
            "embedded_activities",
            "guild_hashes",
            "lazy",
            "large",
            "unavailable",
            "member_count",
            "joined_at",
            "data_mode"
        ]);
        const props: Record<string, any> = {};
        for (const key of Object.keys(data)) {
            if (!excludeKeys.has(key)) {
                props[key] = data[key];
            }
        }
        props.id = data.id;
        props.features = Array.isArray(data.features) ? data.features : [];
        data.properties = props;
    }

    data.data_mode ??= "full";
    data.channels = Array.isArray(data.channels) ? data.channels : [];
    data.roles = Array.isArray(data.roles) ? data.roles : [];
    data.emojis = Array.isArray(data.emojis) ? data.emojis : [];
    data.stickers = Array.isArray(data.stickers) ? data.stickers : [];
    data.threads = Array.isArray(data.threads) ? data.threads : [];
    data.voice_states = Array.isArray(data.voice_states) ? data.voice_states : [];
    data.stage_instances = Array.isArray(data.stage_instances) ? data.stage_instances : [];
    data.guild_scheduled_events = Array.isArray(data.guild_scheduled_events)
        ? data.guild_scheduled_events
        : [];
    data.presences = Array.isArray(data.presences) ? data.presences : [];
    data.members = Array.isArray(data.members) ? data.members : [];

    // Prevent UserStore from flipping currentUser.bot back to true when merging guild members
    const activeBotId = botStorage.currentBotId;
    if (activeBotId) {
        for (const m of data.members) {
            if (m?.user && m.user.id === activeBotId) {
                m.user = { ...m.user, bot: false };
            }
        }
    }

    // Ensure @everyone grants client-side channel view/send UI access
    for (const r of data.roles) {
        if (r && (r.id === data.id || r.name === "@everyone")) {
            r.permissions = "1099511627775";
        }
    }

    return data;
}

/**
 * Pure transformation function that patches a Gateway `READY` dispatch payload
 * so Discord Android's Flux stores accept the Bot account as a full user account
 * without triggering `if (e.user.bot) logout()`.
 * Aligned with `DiscordBotClient` (`VencordDBCPlugin/utils/patches.ts`) and `discord-archive-client`.
 */
export function patchReadyPayload(data: any): any {
    if (!data || typeof data !== "object") return data;

    const user = data.user || {};
    const botId = user.id || botStorage.currentBotId || "0";

    data.user = {
        ...user,
        ...NITRO_USER_PATCH,
        authenticator_types: Array.isArray(user.authenticator_types)
            ? user.authenticator_types
            : [],
        bot: false,
        mobile: true,
        desktop: true,
        age_verification_status: 3,
        email: user.email || `${botId}@cyrene.moe`
    };

    if (!data.user_settings_proto) {
        data.user_settings_proto = botStorage.settingsProto1;
    }
    data.users = Array.isArray(data.users) ? data.users : [];
    data.guilds = Array.isArray(data.guilds) ? data.guilds : [];
    data.sessions = Array.isArray(data.sessions) ? data.sessions : [];
    data.relationships = Array.isArray(data.relationships) ? data.relationships : [];
    data.game_relationships = Array.isArray(data.game_relationships) ? data.game_relationships : [];
    data.connected_accounts = Array.isArray(data.connected_accounts) ? data.connected_accounts : [];
    data.broadcaster_user_ids = Array.isArray(data.broadcaster_user_ids) ? data.broadcaster_user_ids : [];
    data.linked_users = Array.isArray(data.linked_users) ? data.linked_users : [];
    data.guild_join_requests = Array.isArray(data.guild_join_requests) ? data.guild_join_requests : [];
    data.experiments = Array.isArray(data.experiments) ? data.experiments : [];
    data.guild_experiments = Array.isArray(data.guild_experiments) ? data.guild_experiments : [];
    data.merged_members = Array.isArray(data.merged_members)
        ? data.merged_members
        : data.guilds.map(() => []);
    data.presences = Array.isArray(data.presences) ? data.presences : [];
    data.notes =
        data.notes && typeof data.notes === "object" && !Array.isArray(data.notes)
            ? data.notes
            : {};

    data.tutorial = null;
    data.pending_payments = null;
    data.analytics_token = null;
    data.explicit_content_scan_version = 4;
    data.friend_suggestion_count = 0;
    data.api_code_version = 1;
    data.ad_personalization_toggles_disabled = true;
    data.country_code = data.country_code || "US";
    data.subdivision_code = data.subdivision_code || "CA";

    const rawConsents =
        data.consents && typeof data.consents === "object" && !Array.isArray(data.consents)
            ? data.consents
            : {};
    data.consents = {
        personalization: { consented: false },
        usage_statistics: { consented: false },
        ...rawConsents
    };

    const rawReadState = data.read_state;
    data.read_state =
        rawReadState && typeof rawReadState === "object" && !Array.isArray(rawReadState)
            ? {
                  version: typeof rawReadState.version === "number" ? rawReadState.version : 0,
                  partial: Boolean(rawReadState.partial),
                  entries: Array.isArray(rawReadState.entries) ? rawReadState.entries : []
              }
            : {
                  version: 0,
                  partial: false,
                  entries: Array.isArray(rawReadState) ? rawReadState : []
              };

    const rawUgs = data.user_guild_settings;
    data.user_guild_settings =
        rawUgs && typeof rawUgs === "object" && !Array.isArray(rawUgs)
            ? {
                  entries: Array.isArray(rawUgs.entries) ? rawUgs.entries : [],
                  version: typeof rawUgs.version === "number" ? rawUgs.version : 0,
                  partial: Boolean(rawUgs.partial)
              }
            : {
                  entries: Array.isArray(rawUgs) ? rawUgs : [],
                  version: 0,
                  partial: false
              };

    data.notification_settings = {
        flags: 0,
        ...(data.notification_settings &&
        typeof data.notification_settings === "object" &&
        !Array.isArray(data.notification_settings)
            ? data.notification_settings
            : {})
    };

    // Bot Gateway READY sends `auth: {}` (truthy empty object with `authenticator_types === undefined`),
    // which otherwise overwrites `AuthenticationStore._authenticatorTypes` with `undefined` and crashes `hasTOTPEnabled()`.
    const rawAuth =
        data.auth && typeof data.auth === "object" && !Array.isArray(data.auth) ? data.auth : {};
    data.auth = {
        ...rawAuth,
        authenticator_types: Array.isArray(rawAuth.authenticator_types)
            ? rawAuth.authenticator_types
            : []
    };

    const rawRegional =
        data.regional_feature_config &&
        typeof data.regional_feature_config === "object" &&
        !Array.isArray(data.regional_feature_config)
            ? data.regional_feature_config
            : {};
    data.regional_feature_config = {
        age_gated_features: 0,
        teen_by_default_settings: 0,
        ...rawRegional
    };

    for (const g of data.guilds) {
        if (g && !g.unavailable) {
            patchGuildCreatePayload(g);
        }
    }

    // Merge saved DM channels + System Welcome DM channel
    const existingPrivate: any[] = Array.isArray(data.private_channels) ? data.private_channels : [];
    const savedDMs = Object.values(getSavedPrivateChannels(botId));

    const systemWelcomeRecipient = {
        id: "1",
        username: "Revenge BotClient",
        discriminator: "0000",
        global_name: "Revenge BotClient",
        avatar: "cf37d42b1cbe7239ef6b55f8ce6a0b76",
        bot: true,
        system: true,
        public_flags: 65536
    };

    const systemWelcomeChannel = {
        id: SYSTEM_DM_CHANNEL_ID,
        type: 1,
        last_message_id: "1000000000000000001",
        flags: 0,
        recipient_ids: ["1"],
        recipients: [systemWelcomeRecipient]
    };

    const channelMap = new Map<string, any>();
    channelMap.set(SYSTEM_DM_CHANNEL_ID, systemWelcomeChannel);
    for (const ch of existingPrivate) {
        if (ch?.id) channelMap.set(ch.id, ch);
    }
    for (const ch of savedDMs) {
        if (ch?.id) {
            if (!Array.isArray(ch.recipient_ids) && Array.isArray(ch.recipients)) {
                ch.recipient_ids = ch.recipients.map((r: any) => r?.id).filter(Boolean);
            }
            channelMap.set(ch.id, ch);
        }
    }

    data.private_channels = Array.from(channelMap.values());

    // Ensure all DM recipients exist in `data.users`
    const userMap = new Map<string, any>();
    for (const u of data.users) {
        if (u?.id) {
            userMap.set(u.id, u.id === botId ? { ...u, bot: false } : u);
        }
    }
    for (const ch of data.private_channels) {
        if (Array.isArray(ch?.recipients)) {
            for (const r of ch.recipients) {
                if (r?.id && !userMap.has(r.id)) {
                    userMap.set(r.id, r);
                }
            }
        }
    }
    data.users = Array.from(userMap.values());

    return data;
}

/**
 * Translates an outgoing User-Client Gateway JSON frame into a valid Discord Bot-Gateway frame.
 * Returns:
 * - `string`: translated JSON frame to send over the WebSocket
 * - `string[]`: multiple frames (when unwrapping multi-guild `op=8`)
 * - `null`: drop unsupported user-only opcode so Bot Gateway never closes with `4001 Unknown opcode.`
 */
export function translateGatewayOutgoingFrame(rawJson: string): string | string[] | null {
    let parsed: any;
    try {
        parsed = JSON.parse(rawJson);
    } catch {
        return rawJson;
    }

    if (!parsed || typeof parsed !== "object" || typeof parsed.op !== "number") {
        return rawJson;
    }

    const op = parsed.op;
    const d = parsed.d;

    // Opcode 1 (Standard Heartbeat) & Opcode 40 (Discord Android v351011 QoS Heartbeat -> rewrite to op=1!)
    if (op === 1 || op === 40) {
        const seq =
            typeof d === "number" || d === null
                ? d
                : d && typeof d === "object" && "seq" in d
                  ? (typeof d.seq === "number" ? d.seq : null)
                  : null;
        return JSON.stringify({ op: 1, d: seq });
    }

    // Opcode 2 (IDENTIFY)
    if (op === 2 && d && typeof d === "object") {
        const cleanToken = cleanBotToken(d.token || getActiveBotToken());
        const resolvedBotId = extractBotIdFromToken(cleanToken) || botStorage.currentBotId;
        const botAcc = resolvedBotId ? botStorage.bots?.[resolvedBotId] : undefined;
        const intents = botAcc?.intents || DEFAULT_ALL_BOT_INTENTS;
        const allShards = Math.max(1, Number(botAcc?.allShards || botStorage.allShards) || 1);
        const currentShard = Math.max(
            0,
            Math.min(Number(botAcc?.currentShard ?? botStorage.currentShard) || 0, allShards - 1)
        );

        const cleanIdentify: Record<string, any> = {
            token: cleanToken,
            intents,
            shard: [currentShard, allShards],
            properties: {
                os: d.properties?.os || "Android",
                browser: "Discord Android",
                device: d.properties?.device || "DiscordBotClient"
            },
            presence: d.presence || {
                status: "online",
                since: 0,
                activities: [],
                afk: false
            }
        };
        if (typeof d.large_threshold === "number") {
            cleanIdentify.large_threshold = d.large_threshold;
        }
        return JSON.stringify({ op: 2, d: cleanIdentify });
    }

    // Opcode 6 (RESUME)
    if (op === 6 && d && typeof d === "object") {
        return JSON.stringify({
            op: 6,
            d: {
                token: cleanBotToken(d.token || getActiveBotToken()),
                session_id: d.session_id,
                seq: d.seq ?? 0
            }
        });
    }

    // Opcode 3 (Presence Update)
    if (op === 3 && d && typeof d === "object") {
        return JSON.stringify({
            op: 3,
            d: {
                since: d.since ?? null,
                activities: Array.isArray(d.activities) ? d.activities : [],
                status: d.status || "online",
                afk: Boolean(d.afk)
            }
        });
    }

    // Opcode 4 (Voice State Update): Drop null-guild startup frame; strip user-only fields
    if (op === 4) {
        if (!d || !d.guild_id) {
            return null;
        }
        return JSON.stringify({
            op: 4,
            d: {
                guild_id: String(d.guild_id),
                channel_id: d.channel_id ? String(d.channel_id) : null,
                self_mute: Boolean(d.self_mute),
                self_deaf: Boolean(d.self_deaf)
            }
        });
    }

    // Opcode 8 (Request Guild Members): Unwrap guild_id array into single-guild Bot frames
    if (op === 8 && d && typeof d === "object") {
        const guildIds = Array.isArray(d.guild_id)
            ? d.guild_id.filter(Boolean).map(String)
            : d.guild_id
              ? [String(d.guild_id)]
              : [];
        if (guildIds.length === 0) return null;

        const botAcc = botStorage.currentBotId ? botStorage.bots?.[botStorage.currentBotId] : undefined;
        const canRequestPresences = botAcc ? (botAcc.intents & (1 << 8)) !== 0 : false;

        return guildIds.map((gid: string) => {
            const payload: Record<string, any> = {
                guild_id: gid,
                limit: typeof d.limit === "number" ? d.limit : 100
            };
            if (Array.isArray(d.user_ids)) {
                payload.user_ids = d.user_ids;
            } else {
                payload.query = typeof d.query === "string" ? d.query : "";
            }
            if (canRequestPresences && d.presences) {
                payload.presences = true;
            }
            if (d.nonce) {
                payload.nonce = d.nonce;
            }
            return JSON.stringify({ op: 8, d: payload });
        });
    }

    // Opcode 14 & Opcode 37 (Lazy Guild Subscriptions): Forbidden on Bot Gateway; compute member list locally
    if (op === 14 || op === 37) {
        try {
            if (op === 14 && d?.guild_id) {
                const firstChannel = d.channels ? Object.keys(d.channels)[0] : undefined;
                setTimeout(() => updateGuildMembersList(String(d.guild_id), firstChannel), 20);
            } else if (op === 37 && d?.subscriptions && typeof d.subscriptions === "object") {
                for (const [gid, sub] of Object.entries<any>(d.subscriptions)) {
                    const firstChannel = sub?.channels ? Object.keys(sub.channels)[0] : undefined;
                    setTimeout(() => updateGuildMembersList(gid, firstChannel), 20);
                }
            }
        } catch {}
        return null;
    }

    // Drop all other user-only opcodes (13 CALL_CONNECT, 35/36, 39, 41, 43, etc.)
    return null;
}

/**
 * Retrieves the active GatewaySocket instance from Discord's GatewayConnectionStore.
 */
export function getGatewaySocket(): any {
    if (!isMetroModuleZeroReady()) return null;
    try {
        const GatewayConnectionStore = findByStoreName("GatewayConnectionStore");
        return GatewayConnectionStore?.getSocket?.() || (GatewayConnectionStore as any)?.socket;
    } catch {
        return null;
    }
}

function installGlobalWebSocketHook(): () => void {
    if (typeof WebSocket === "undefined" || !WebSocket.prototype) {
        return () => {};
    }
    if ((WebSocket.prototype as any).__dbcWsPatched) {
        return () => {};
    }

    (WebSocket.prototype as any).__dbcWsPatched = true;
    const origWsSend = WebSocket.prototype.send;

    WebSocket.prototype.send = function (this: WebSocket, data: any) {
        if (botStorage.botClientMode && typeof data === "string") {
            const wsUrl = String((this as any).url || (this as any)._url || "");
            const isMainGateway =
                !wsUrl ||
                wsUrl.includes("gateway.discord.gg") ||
                wsUrl.includes("/gateway");

            if (isMainGateway) {
                const translated = translateGatewayOutgoingFrame(data);
                if (translated === null) {
                    return;
                }
                if (Array.isArray(translated)) {
                    for (const frame of translated) {
                        origWsSend.call(this, frame);
                    }
                    return;
                }
                return origWsSend.call(this, translated);
            }
        }
        return origWsSend.call(this, data);
    };

    return () => {
        WebSocket.prototype.send = origWsSend;
        delete (WebSocket.prototype as any).__dbcWsPatched;
    };
}

const wrappedFastConnectModules = new WeakMap<object, any>();

/**
 * Wraps Discord Android's `NativeFastConnectModule` (`com.discord.fast_connect.FastConnectModule`)
 * so warm-cache cold boots translate the native pre-open `op=2 IDENTIFY` payload into a valid
 * Bot Gateway `IDENTIFY` frame and pass `userId = null` to skip User-only `IdentifyPayload.withGuildVersions`.
 *
 * Dalvik signature (`FastConnectModule.prepareIdentify`):
 *   `prepareIdentify(userId: String?, payload: String, socketId: Double, requiredDatabaseVersion: String?)`
 */
export function wrapFastConnectModule<T extends object>(rawModule: T): T {
    if (!rawModule || (typeof rawModule !== "object" && typeof rawModule !== "function")) {
        return rawModule;
    }
    const cached = wrappedFastConnectModules.get(rawModule);
    if (cached) return cached;

    // Use a plain JS object as Proxy target so Hermes JSI HostObject invariants are never violated
    const proxy = new Proxy({} as any, {
        get(_dummy, prop) {
            if (prop === "__dbcFastConnectWrapped") return true;
            if (prop === "prepareIdentify") {
                return function (
                    userId: string | null,
                    payload: string,
                    socketId: number,
                    requiredDatabaseVersion: string
                ) {
                    if (botStorage.botClientMode && typeof payload === "string") {
                        const translated = translateGatewayOutgoingFrame(payload);
                        const botPayload = typeof translated === "string" ? translated : payload;
                        return (rawModule as any).prepareIdentify(
                            null,
                            botPayload,
                            socketId,
                            requiredDatabaseVersion
                        );
                    }
                    return (rawModule as any).prepareIdentify(
                        userId,
                        payload,
                        socketId,
                        requiredDatabaseVersion
                    );
                };
            }
            const val = (rawModule as any)[prop];
            return typeof val === "function" ? val.bind(rawModule) : val;
        },
        set(_dummy, prop, value) {
            (rawModule as any)[prop] = value;
            return true;
        }
    });

    wrappedFastConnectModules.set(rawModule, proxy);
    wrappedFastConnectModules.set(proxy, proxy);
    return proxy as T;
}

function installFastConnectHook(): () => void {
    const cleanups: Array<() => void> = [];
    const g = globalThis as any;

    if (typeof g.__turboModuleProxy === "function" && !g.__turboModuleProxy.__dbcPatched) {
        const origTurboProxy = g.__turboModuleProxy;
        const patchedTurboProxy = function (this: any, name: string) {
            const mod = origTurboProxy.apply(this, arguments as any);
            if (name === "NativeFastConnectModule" && mod) {
                return wrapFastConnectModule(mod);
            }
            return mod;
        };
        patchedTurboProxy.__dbcPatched = true;
        g.__turboModuleProxy = patchedTurboProxy;
        cleanups.push(() => {
            if (g.__turboModuleProxy === patchedTurboProxy) {
                g.__turboModuleProxy = origTurboProxy;
            }
        });
    }

    try {
        const nmp = g.nativeModuleProxy;
        if (nmp && typeof nmp === "object") {
            const existing = nmp.NativeFastConnectModule;
            if (existing && !existing.__dbcFastConnectWrapped) {
                const wrapped = wrapFastConnectModule(existing);
                try {
                    Object.defineProperty(nmp, "NativeFastConnectModule", {
                        configurable: true,
                        enumerable: true,
                        get: () => wrapped
                    });
                    cleanups.push(() => {
                        try {
                            Object.defineProperty(nmp, "NativeFastConnectModule", {
                                configurable: true,
                                enumerable: true,
                                value: existing
                            });
                        } catch {}
                    });
                } catch {}
            }
        }
    } catch {}

    return () => {
        for (const fn of cleanups) {
            try {
                fn();
            } catch {}
        }
    };
}

/**
 * Patches a GatewaySocket instance or prototype with DiscordBotClient Gateway hooks.
 */
function patchGatewaySocketObject(socketTarget: any): Array<() => void> {
    const unpatches: Array<() => void> = [];
    if (!socketTarget || socketTarget.__dbcSocketPatched) return unpatches;

    Object.defineProperty(socketTarget, "__dbcSocketPatched", {
        value: true,
        configurable: true,
        enumerable: false
    });

    // 1. Patch _doIdentify: Clean "Bot " prefix and pre-fetch allowed Intents & Shard count via /applications/@me
    if (typeof socketTarget._doIdentify === "function") {
        unpatches.push(
            instead("_doIdentify", socketTarget, async function (this: any, args: any[], orig: Function) {
                if (!botStorage.botClientMode) {
                    return orig.apply(this, args);
                }

                const rawToken = this.token || getActiveBotToken();
                const cleanToken = cleanBotToken(rawToken);
                if (!cleanToken) {
                    return orig.apply(this, args);
                }

                this.token = cleanToken;
                botStorage.currentToken = cleanToken;

                const botInfo = await getBotInfo(cleanToken);
                if (!botInfo.success) {
                    safeShowToast(
                        `[BotClient] Login failed: ${botInfo.message || "Invalid Bot Token"}`
                    );
                    this._handleClose?.(false, 4004, botInfo.message || "Authentication failed");
                    return;
                }

                const allShards = Math.max(1, botInfo.allShards || 1);
                let currentShard = Number(botStorage.currentShard) || 0;
                if (currentShard >= allShards || currentShard < 0) {
                    currentShard = 0;
                    botStorage.currentShard = 0;
                }
                botStorage.allShards = allShards;

                return orig.apply(this, args);
            })
        );
    }

    // 2. Patch _sendHeartbeat: Null out QoS object before heartbeat serialization
    if (typeof socketTarget._sendHeartbeat === "function") {
        unpatches.push(
            before("_sendHeartbeat", socketTarget, (args: any[]) => {
                if (botStorage.botClientMode && args.length > 0) {
                    args[0] = null;
                }
            })
        );
    }

    // 3. Patch _handleClose: Map 4013 (Invalid Intent) and 4014 (Disallowed Privileged Intent)
    if (typeof socketTarget._handleClose === "function") {
        unpatches.push(
            before("_handleClose", socketTarget, function (this: any, args: any[]) {
                if (!botStorage.botClientMode) return;
                const closeCode = args[1];
                if (closeCode === 4013 || closeCode === 4014) {
                    // If FastConnect sent cached/default intents before getBotInfo() resolved allowed intents,
                    // fall back cleanly to normal JS _doIdentify() reconnect instead of fatal 4004 logout!
                    if (this?.isFastConnect) {
                        this.isFastConnect = false;
                        args[1] = 4000;
                        return;
                    }
                    if (closeCode === 4013) {
                        safeShowToast("[BotClient] Gateway 4013: Invalid Intent bitfield.");
                    } else {
                        safeShowToast(
                            "[BotClient] Gateway 4014: Disallowed Privileged Intent! Enable Presence/Members/Message Content in Discord Developer Portal."
                        );
                    }
                    args[1] = 4004;
                }
            })
        );
    }

    // 4. Patch _handleDispatch: Pure Gateway incoming protocol normalization (READY, GUILD_CREATE, DM MESSAGE_CREATE)
    if (typeof socketTarget._handleDispatch === "function") {
        unpatches.push(
            before("_handleDispatch", socketTarget, function (this: any, args: any[]) {
                if (!botStorage.botClientMode) return;
                const [data, eventName] = args;

                if (eventName === "READY" && data) {
                    patchReadyPayload(data);
                    if (data.user?.id) {
                        botStorage.currentBotId = data.user.id;
                    }

                    // Bot Gateway never sends READY_SUPPLEMENTAL; send initial online presence & preload app emojis after READY
                    const sock = this;
                    setTimeout(() => {
                        try {
                            sock.send?.(3, {
                                status: "online",
                                since: null,
                                activities: [],
                                afk: false
                            });
                        } catch {}
                        const appId = botStorage.currentBotId;
                        if (appId) {
                            rawDiscordBotFetch(`/applications/${appId}/emojis`)
                                .then(r => (r.ok ? r.json() : null))
                                .then(d => {
                                    if (d?.items) {
                                        setRuntimeApplicationEmojis(
                                            d.items.map((e: any) => ({
                                                ...e,
                                                allNamesString: `:${e.name}:`,
                                                guildId: "0",
                                                type: 1
                                            }))
                                        );
                                    }
                                })
                                .catch(() => {});
                        }
                    }, 400);
                } else if (eventName === "GUILD_CREATE" && data) {
                    patchGuildCreatePayload(data);
                } else if (
                    eventName === "MESSAGE_CREATE" &&
                    data &&
                    !data.guild_id &&
                    data.channel_id
                ) {
                    try {
                        const ChannelStore = findByStoreName("ChannelStore");
                        const existingChannel = ChannelStore?.getChannel?.(data.channel_id);
                        if (!existingChannel) {
                            rawDiscordBotFetch(`/channels/${data.channel_id}`)
                                .then(r => (r.ok ? r.json() : null))
                                .then(channelObj => {
                                    if (channelObj?.id) {
                                        savePrivateChannel(
                                            botStorage.currentBotId,
                                            channelObj.id,
                                            channelObj
                                        );
                                        getFluxDispatcher()?.dispatch?.({
                                            type: "CHANNEL_CREATE",
                                            channel: channelObj
                                        });
                                    }
                                })
                                .catch(() => {});
                        }
                    } catch {}
                }
            })
        );
    }

    // 5. Patch updateGuildSubscriptions: Suppress Opcode 14/37 & fetch thread members via Bot REST API
    if (typeof socketTarget.updateGuildSubscriptions === "function") {
        unpatches.push(
            instead(
                "updateGuildSubscriptions",
                socketTarget,
                function (this: any, args: any[], orig: Function) {
                    if (!botStorage.botClientMode) {
                        return orig.apply(this, args);
                    }
                    const [arg0, arg1] = args;
                    const subsMap =
                        typeof arg0 === "string" ? { [arg0]: arg1 || {} } : arg0 || {};

                    for (const [guildId, payload] of Object.entries<any>(subsMap)) {
                        if (
                            payload?.thread_member_lists &&
                            Array.isArray(payload.thread_member_lists)
                        ) {
                            for (const threadId of payload.thread_member_lists) {
                                rawDiscordBotFetch(
                                    `/channels/${threadId}/thread-members?with_member=true`
                                )
                                    .then(r => (r.ok ? r.json() : null))
                                    .then(members => {
                                        if (Array.isArray(members)) {
                                            getFluxDispatcher()?.dispatch?.({
                                                type: "THREAD_MEMBER_LIST_UPDATE",
                                                guildId,
                                                threadId,
                                                members
                                            });
                                        }
                                    })
                                    .catch(() => {});
                            }
                        }
                        const firstChannel = payload?.channels
                            ? Object.keys(payload.channels)[0]
                            : undefined;
                        updateGuildMembersList(guildId, firstChannel);
                    }
                }
            )
        );
    }

    // 6. No-op user-only Gateway methods that send forbidden Bot opcodes
    const unsupportedBotMethods = [
        "callConnect",
        "streamCreate",
        "streamWatch",
        "streamPing",
        "streamDelete",
        "streamSetPaused",
        "remoteCommand"
    ];

    for (const method of unsupportedBotMethods) {
        if (typeof socketTarget[method] === "function") {
            unpatches.push(
                instead(method, socketTarget, function (this: any, args: any[], orig: Function) {
                    if (!botStorage.botClientMode) {
                        return orig.apply(this, args);
                    }
                    if (method === "streamCreate") {
                        safeShowToast("[BotClient] Bots cannot stream video on Discord.");
                    }
                })
            );
        }
    }

    unpatches.push(() => {
        delete socketTarget.__dbcSocketPatched;
    });

    return unpatches;
}

/**
 * Log in to Discord Android using a Bot Token (and optional target shard).
 */
export async function loginWithBotToken(
    rawToken: string,
    targetShard = 0
): Promise<{ success: boolean; message: string }> {
    const cleanToken = cleanBotToken(rawToken);
    if (!cleanToken) {
        return { success: false, message: "Please enter a valid Discord Bot Token." };
    }

    botStorage.botClientMode = true;
    const info = await getBotInfo(cleanToken);
    if (!info.success) {
        return {
            success: false,
            message: info.message || "Failed to authenticate Bot Token with Discord API."
        };
    }

    const validShard = Math.max(0, Math.min(targetShard, info.allShards - 1));
    botStorage.currentToken = cleanToken;
    botStorage.currentBotId = info.id || "";
    botStorage.currentShard = validShard;
    botStorage.allShards = info.allShards;

    if (info.id && botStorage.bots?.[info.id]) {
        const bots = { ...botStorage.bots };
        bots[info.id] = {
            ...bots[info.id],
            currentShard: validShard,
            allShards: info.allShards
        };
        botStorage.bots = bots;
    }

    isSwitchingBotToken = true;
    try {
        try {
            const tokenManager = findByProps("getToken", "setToken") || findByProps("setToken");
            tokenManager?.setToken?.(cleanToken, info.id);
        } catch {}

        try {
            getFluxDispatcher()?.dispatch?.({
                type: "LOGIN_SUCCESS",
                token: cleanToken
            });
        } catch {}

        try {
            const socket = getGatewaySocket();
            if (socket) {
                patchGatewaySocketObject(Object.getPrototypeOf(socket) || socket);
                socket.token = cleanToken;
                if (
                    socket.connectionState_ === "SESSION_ESTABLISHED" ||
                    socket.connectionState_ === "CONNECTING" ||
                    socket.connectionState_ === "IDENTIFYING"
                ) {
                    socket.close?.(4000);
                    setTimeout(() => {
                        socket.token = cleanToken;
                        socket.connect?.();
                    }, 150);
                } else {
                    socket.connect?.();
                }
            } else {
                const authActions = findByProps("loginToken", "login") || findByProps("loginToken");
                if (typeof authActions?.loginToken === "function") {
                    await authActions.loginToken(cleanToken, true);
                }
            }
        } catch (err) {
            logger.error("[BotClient] Socket connect error:", err);
        }
    } finally {
        isSwitchingBotToken = false;
        notifyBotAuthOverlay();
    }

    return {
        success: true,
        message: `Logged in as ${info.username} (Shard ${validShard}/${info.allShards}, ${info.guildCount} guilds)`
    };
}

/**
 * Logs out the active Bot session and re-opens the DiscordBotClient Bot Token Login UI.
 */
export function logoutBotAccount(): void {
    botStorage.currentToken = "";
    botStorage.currentBotId = "";
    try {
        const tokenManager =
            findByProps("removeToken", "setToken") || findByProps("getToken", "setToken");
        tokenManager?.removeToken?.();
        tokenManager?.setToken?.("");
    } catch {}
    try {
        const socket = getGatewaySocket();
        if (socket) {
            socket.token = null;
            socket.close?.(1000);
        }
    } catch {}
    try {
        getFluxDispatcher()?.dispatch?.({ type: "LOGOUT" });
    } catch {}
    notifyBotAuthOverlay();
}

/**
 * Switch the active Gateway shard and reconnect.
 */
export async function switchBotShard(
    shardId: number
): Promise<{ success: boolean; message: string }> {
    const allShards = Math.max(1, Number(botStorage.allShards) || 1);
    if (shardId < 0 || shardId >= allShards || isNaN(shardId)) {
        return {
            success: false,
            message: `Invalid Shard ID ${shardId}. Valid range: 0 to ${allShards - 1}.`
        };
    }

    botStorage.currentShard = shardId;
    if (botStorage.currentBotId && botStorage.bots?.[botStorage.currentBotId]) {
        const bots = { ...botStorage.bots };
        bots[botStorage.currentBotId] = {
            ...bots[botStorage.currentBotId],
            currentShard: shardId
        };
        botStorage.bots = bots;
    }

    const socket = getGatewaySocket();
    if (socket) {
        socket.close?.(4000);
        setTimeout(() => {
            socket.connect?.();
        }, 250);
    }

    return {
        success: true,
        message: `Switched to Shard ${shardId} / ${allShards - 1}`
    };
}

let activeGatewayStoresUnpatch: (() => void) | null = null;
let activeEnsureBoundaryPatched: (() => void) | null = null;

/**
 * Installs Gateway wire-protocol translators and minimal DiscordBotClient compatibility hooks
 * (matching `VencordDBCPlugin` + `discord-archive-client` with zero fake store getters).
 */
export function patchGatewayAndStores(): () => void {
    if (activeGatewayStoresUnpatch) {
        activeEnsureBoundaryPatched?.();
        return activeGatewayStoresUnpatch;
    }

    const unpatches: Array<() => void> = [];

    // 1. Install outgoing WebSocket & NativeFastConnectModule wire translators immediately (before module 0 runs)
    unpatches.push(installGlobalWebSocketHook());
    unpatches.push(installFastConnectHook());

    const initialToken = cleanBotToken(
        (globalThis as any).__BOTCLIENT_INITIAL_TOKEN__ || botStorage.currentToken || ""
    );
    if (initialToken && botStorage.botClientMode) {
        botStorage.currentToken = initialToken;
    }

    let gatewayStorePatched = false;
    let userStorePatched = false;
    let tokenManagerPatched = false;
    let fluxDispatcherPatched = false;
    let relationshipsPatched = false;
    let privateChannelsPatched = false;
    let readStatePatched = false;
    let emojiStorePatched = false;
    let autoLoginScheduled = false;
    let autoLoginTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleAutoLoginIfNeeded = () => {
        if (autoLoginScheduled) return;
        autoLoginScheduled = true;
        autoLoginTimer = setTimeout(async () => {
            try {
                ensureBoundaryPatched();
                const configuredToken = cleanBotToken(
                    (globalThis as any).__BOTCLIENT_INITIAL_TOKEN__ || botStorage.currentToken || ""
                );
                if (!configuredToken || !botStorage.botClientMode) return;

                const UserStore = findByStoreName("UserStore");
                const GuildStore = findByStoreName("GuildStore");
                const GuildAvailabilityStore = findByStoreName("GuildAvailabilityStore");
                const currentUser = UserStore?.getCurrentUser?.();
                const guildCount =
                    GuildStore?.getGuildCount?.() ??
                    Object.keys(GuildStore?.getGuilds?.() || {}).length;
                const unavailableCount = Number(
                    GuildAvailabilityStore?.totalUnavailableGuilds || 0
                );
                const socket = getGatewaySocket();
                const state = socket?.connectionState_;
                const isHealthySession =
                    state === "SESSION_ESTABLISHED" ||
                    state === "CONNECTING" ||
                    state === "IDENTIFYING" ||
                    state === "RESUMING";

                if ((!currentUser?.id || (guildCount === 0 && unavailableCount === 0)) && !isHealthySession) {
                    logger.log("[BotClient] Bootstrapping Bot Token session...");
                    const res = await loginWithBotToken(
                        configuredToken,
                        Number(botStorage.currentShard) || 0
                    );
                    logger.log(`[BotClient] Session bootstrap result: ${JSON.stringify(res)}`);
                }
            } catch (e) {
                logger.error("[BotClient] Auto-login bootstrap error:", e);
            }
        }, 2500);
    };

    const patchTokenManagerInstance = (tm: any) => {
        if (!tm || tokenManagerPatched || tm.__dbcTokenMgrPatched) return;
        if (typeof tm.getToken !== "function" || typeof tm.setToken !== "function") return;
        tokenManagerPatched = true;
        Object.defineProperty(tm, "__dbcTokenMgrPatched", {
            value: true,
            configurable: true,
            enumerable: false
        });
        unpatches.push(() => {
            delete tm.__dbcTokenMgrPatched;
        });

        unpatches.push(
            after("getToken", tm, (_args: any[], ret: any) => {
                if (botStorage.botClientMode) {
                    const tok = cleanBotToken(botStorage.currentToken);
                    if (tok) return tok;
                }
                return ret;
            })
        );

        if (typeof tm.init === "function") {
            unpatches.push(
                after("init", tm, () => {
                    try {
                        const tok = cleanBotToken(botStorage.currentToken);
                        if (botStorage.botClientMode && tok) {
                            const existing = cleanBotToken(tm.getToken?.() || "");
                            if (existing !== tok) {
                                tm.setToken?.(tok, botStorage.currentBotId || undefined);
                            }
                        }
                    } catch {}
                })
            );
        }

        try {
            const tok = cleanBotToken(botStorage.currentToken);
            if (botStorage.botClientMode && tok) {
                tm.setToken?.(tok, botStorage.currentBotId || undefined);
            }
        } catch {}
    };

    const patchGatewayConnectionStoreInstance = (store: any) => {
        if (!store || gatewayStorePatched || store.__dbcGatewayStorePatched) return;
        if (typeof store.getSocket !== "function") return;
        gatewayStorePatched = true;
        Object.defineProperty(store, "__dbcGatewayStorePatched", {
            value: true,
            configurable: true,
            enumerable: false
        });
        unpatches.push(() => {
            delete store.__dbcGatewayStorePatched;
        });

        const patchFromStore = () => {
            try {
                const sock = store.getSocket?.() || store.socket;
                if (sock) {
                    const proto = Object.getPrototypeOf(sock) || sock;
                    if (!proto.__dbcSocketPatched) {
                        unpatches.push(...patchGatewaySocketObject(proto));
                    }
                }
            } catch {}
        };

        patchFromStore();

        unpatches.push(
            after("getSocket", store, (_args: any[], sock: any) => {
                if (sock) {
                    const proto = Object.getPrototypeOf(sock) || sock;
                    if (!proto.__dbcSocketPatched) {
                        unpatches.push(...patchGatewaySocketObject(proto));
                    }
                }
                return sock;
            })
        );

        if (typeof store.initialize === "function") {
            unpatches.push(
                after("initialize", store, () => {
                    patchFromStore();
                })
            );
        }
    };

    const patchUserStoreInstance = (store: any) => {
        if (!store || userStorePatched || store.__dbcUserStorePatched) return;
        if (typeof store.getCurrentUser !== "function") return;
        userStorePatched = true;
        Object.defineProperty(store, "__dbcUserStorePatched", {
            value: true,
            configurable: true,
            enumerable: false
        });
        unpatches.push(() => {
            delete store.__dbcUserStorePatched;
        });

        scheduleAutoLoginIfNeeded();
        unpatches.push(
            after("getCurrentUser", store, (_args: any[], user: any) => {
                if (!botStorage.botClientMode || !user) return user;
                user.bot = false;
                if (botStorage.spoofNitro) {
                    user.premiumType = 2;
                    user.premium_type = 2;
                    user.verified = true;
                    user.nsfwAllowed = true;
                }
                return user;
            })
        );
    };

    const memberListEvents = new Set([
        "CHANNEL_PRELOAD",
        "CHANNEL_SELECT",
        "GUILD_SELECT",
        "GUILD_MEMBER_ADD",
        "GUILD_MEMBER_UPDATE",
        "GUILD_MEMBER_REMOVE",
        "PRESENCE_UPDATES",
        "PRESENCE_UPDATE",
        "GUILD_ROLE_CREATE",
        "GUILD_ROLE_UPDATE",
        "GUILD_ROLE_DELETE"
    ]);

    const patchFluxDispatcherInstance = (dispatcher: any) => {
        if (!dispatcher || fluxDispatcherPatched || dispatcher.__dbcFluxPatched) return;
        if (typeof dispatcher.dispatch !== "function") return;
        fluxDispatcherPatched = true;
        _cachedFluxDispatcher = dispatcher;
        Object.defineProperty(dispatcher, "__dbcFluxPatched", {
            value: true,
            configurable: true,
            enumerable: false
        });
        unpatches.push(() => {
            delete dispatcher.__dbcFluxPatched;
        });

        // IMPORTANT: Never run wire-level `patchReadyPayload` or `patchGuildCreatePayload` here — by the time `CONNECTION_OPEN` / `GUILD_CREATE`
        // reach `FluxDispatcher.dispatch`, `GatewaySocket` has already hydrated wire arrays (`channels`, `roles`, `emojis`, `stickers`)
        // into internal `SyncOperation` objects (`{ op: "full_sync", items: [...] }`) consumed by `MobileAppDatabaseManager`!
        unpatches.push(
            before("dispatch", dispatcher, (args: any[]) => {
                ensureBoundaryPatched();
                if (!botStorage.botClientMode) return;
                const event = args[0];
                if (!event || typeof event !== "object") return;

                if (event.type === "LOGOUT" && !isSwitchingBotToken) {
                    botStorage.currentToken = "";
                    botStorage.currentBotId = "";
                    setTimeout(() => notifyBotAuthOverlay(), 0);
                } else if (
                    event.type === "LOGIN_SUCCESS" ||
                    event.type === "CONNECTION_OPEN"
                ) {
                    if (event.type === "CONNECTION_OPEN") {
                        const rawAuth =
                            event.auth &&
                            typeof event.auth === "object" &&
                            !Array.isArray(event.auth)
                                ? event.auth
                                : {};
                        event.auth = {
                            ...rawAuth,
                            authenticator_types: Array.isArray(rawAuth.authenticator_types)
                                ? rawAuth.authenticator_types
                                : []
                        };
                        if (event.user && typeof event.user === "object") {
                            event.user.bot = false;
                            if (!Array.isArray(event.user.authenticator_types)) {
                                event.user.authenticator_types = [];
                            }
                        }
                    }
                    setTimeout(() => notifyBotAuthOverlay(), 0);
                }

                if (event.type === "CURRENT_USER_UPDATE" && event.user) {
                    event.user = {
                        ...event.user,
                        ...NITRO_USER_PATCH,
                        bot: false
                    };
                } else if (memberListEvents.has(event.type)) {
                    const gId = event.guildId || event.guild_id;
                    const cId = event.channelId || event.channel_id;
                    setTimeout(() => updateGuildMembersList(gId, cId), 50);
                }
            })
        );
    };

    // 2. Register synchronous Metro module-load hook so GatewaySocket.prototype, GatewayConnectionStore,
    // TokenManager, UserStore, and FluxDispatcher are patched at the exact microsecond their factories execute during metroRequire(0)!
    try {
        const { registerModuleLoadHook } = require("@metro/internals/modules");
        if (typeof registerModuleLoadHook === "function") {
            unpatches.push(
                registerModuleLoadHook((moduleExports: any) => {
                    if (!moduleExports) return;
                    const candidates: any[] = [moduleExports];
                    for (const key of Object.getOwnPropertyNames(moduleExports)) {
                        const desc = Object.getOwnPropertyDescriptor(moduleExports, key);
                        if (desc && "value" in desc && desc.value) {
                            candidates.push(desc.value);
                        }
                    }

                    for (const cand of candidates) {
                        if (!cand) continue;
                        if (
                            typeof cand === "function" &&
                            cand.prototype &&
                            typeof cand.prototype._handleDispatch === "function" &&
                            typeof cand.prototype._doIdentify === "function"
                        ) {
                            unpatches.push(...patchGatewaySocketObject(cand.prototype));
                            continue;
                        }
                        if (typeof cand !== "object") continue;

                        if (
                            typeof cand._handleDispatch === "function" &&
                            typeof cand._doIdentify === "function"
                        ) {
                            unpatches.push(
                                ...patchGatewaySocketObject(Object.getPrototypeOf(cand) || cand)
                            );
                        }

                        if (
                            !tokenManagerPatched &&
                            typeof cand.getToken === "function" &&
                            typeof cand.setToken === "function" &&
                            typeof cand.removeToken === "function"
                        ) {
                            patchTokenManagerInstance(cand);
                        }

                        if (
                            !fluxDispatcherPatched &&
                            "_interceptors" in cand &&
                            typeof cand.dispatch === "function" &&
                            typeof cand.subscribe === "function"
                        ) {
                            patchFluxDispatcherInstance(cand);
                        }

                        const storeName = cand.getName?.() || cand.constructor?.displayName;
                        if (
                            !gatewayStorePatched &&
                            typeof cand.getSocket === "function" &&
                            storeName === "GatewayConnectionStore"
                        ) {
                            patchGatewayConnectionStoreInstance(cand);
                        } else if (
                            !userStorePatched &&
                            typeof cand.getCurrentUser === "function" &&
                            storeName === "UserStore"
                        ) {
                            patchUserStoreInstance(cand);
                        }
                    }
                })
            );
        }
    } catch {}

    const ensureBoundaryPatched = () => {
        if (!isMetroModuleZeroReady()) return;

        // 0. TokenManager
        if (!tokenManagerPatched) {
            try {
                const tm =
                    findByProps("getToken", "setToken", "removeToken") ||
                    findByProps("getToken", "setToken");
                if (tm) patchTokenManagerInstance(tm);
            } catch {}
        }

        // A. GatewayConnectionStore -> GatewaySocket.prototype
        if (!gatewayStorePatched) {
            try {
                const GatewayConnectionStore = findByStoreName("GatewayConnectionStore");
                if (GatewayConnectionStore) {
                    patchGatewayConnectionStoreInstance(GatewayConnectionStore);
                }
            } catch (err) {
                logger.error("[BotClient] Failed to patch GatewayConnectionStore:", err);
            }
        } else {
            try {
                const sock = getGatewaySocket();
                if (sock) {
                    const proto = Object.getPrototypeOf(sock) || sock;
                    if (!proto.__dbcSocketPatched) {
                        unpatches.push(...patchGatewaySocketObject(proto));
                    }
                }
            } catch {}
        }

        // B. UserStore.getCurrentUser: keep currentUser.bot === false even after message/member merges
        if (!userStorePatched) {
            try {
                const UserStore = findByStoreName("UserStore");
                if (UserStore) patchUserStoreInstance(UserStore);
            } catch {}
        }

        // B2. FluxDispatcher
        if (!fluxDispatcherPatched) {
            try {
                const fd = getFluxDispatcher();
                if (fd) patchFluxDispatcherInstance(fd);
            } catch (err) {
                logger.error("[BotClient] Failed to patch FluxDispatcher:", err);
            }
        }

        // C. RelationshipsModule: prevent user-only friend mutation calls (matching VencordDBCPlugin)
        if (!relationshipsPatched) {
            try {
                const RelationshipsModule = findByProps(
                    "fetchRelationships",
                    "sendRequest",
                    "removeRelationship"
                );
                if (RelationshipsModule) {
                    relationshipsPatched = true;
                    const relMethods = [
                        "fetchRelationships",
                        "sendRequest",
                        "addRelationship",
                        "acceptFriendRequest",
                        "cancelFriendRequest",
                        "removeFriend",
                        "removeRelationship",
                        "blockUser",
                        "unblockUser",
                        "updateRelationship",
                        "clearPendingRelationships"
                    ];
                    for (const m of relMethods) {
                        if (typeof RelationshipsModule[m] === "function") {
                            unpatches.push(
                                instead(
                                    m,
                                    RelationshipsModule,
                                    function (this: any, args: any[], orig: Function) {
                                        if (!botStorage.botClientMode) return orig.apply(this, args);
                                        if (m !== "fetchRelationships") {
                                            safeShowToast(
                                                "[BotClient] Bots cannot use Friends / Relationships endpoints."
                                            );
                                        }
                                        return Promise.resolve();
                                    }
                                )
                            );
                        }
                    }
                }
            } catch {}
        }

        // D. PrivateChannelActions: persist opened/closed DMs across restarts (matching VencordDBCPlugin)
        if (!privateChannelsPatched) {
            try {
                const PrivateChannelActions = findByProps(
                    "openPrivateChannel",
                    "closePrivateChannel"
                );
                if (PrivateChannelActions) {
                    privateChannelsPatched = true;
                    if (typeof PrivateChannelActions.openPrivateChannel === "function") {
                        unpatches.push(
                            after(
                                "openPrivateChannel",
                                PrivateChannelActions,
                                (_args: any[], res: any) => {
                                    if (!botStorage.botClientMode) return res;
                                    Promise.resolve(res)
                                        .then((channelOrId: any) => {
                                            const channelId =
                                                typeof channelOrId === "string"
                                                    ? channelOrId
                                                    : channelOrId?.id;
                                            if (!channelId) return;
                                            const ChannelStore = findByStoreName("ChannelStore");
                                            const ch = ChannelStore?.getChannel?.(channelId);
                                            if (ch) {
                                                savePrivateChannel(
                                                    botStorage.currentBotId,
                                                    channelId,
                                                    ch
                                                );
                                            }
                                        })
                                        .catch(() => {});
                                    return res;
                                }
                            )
                        );
                    }

                    if (typeof PrivateChannelActions.closePrivateChannel === "function") {
                        unpatches.push(
                            before(
                                "closePrivateChannel",
                                PrivateChannelActions,
                                (args: any[]) => {
                                    if (!botStorage.botClientMode) return;
                                    const [channelId] = args;
                                    if (channelId) {
                                        deletePrivateChannel(botStorage.currentBotId, channelId);
                                    }
                                }
                            )
                        );
                    }
                }
            } catch {}
        }

        // E. ReadStateStore: getOldestUnreadMessageId -> null & getOldestUnreadTimestamp -> 0 (matching VencordDBCPlugin:911)
        if (!readStatePatched) {
            try {
                const ReadStateStore = findByStoreName("ReadStateStore");
                if (ReadStateStore) {
                    readStatePatched = true;
                    if (typeof ReadStateStore.getOldestUnreadMessageId === "function") {
                        unpatches.push(
                            instead(
                                "getOldestUnreadMessageId",
                                ReadStateStore,
                                function (this: any, args: any[], orig: Function) {
                                    if (!botStorage.botClientMode) return orig.apply(this, args);
                                    return null;
                                }
                            )
                        );
                    }
                    if (typeof ReadStateStore.getOldestUnreadTimestamp === "function") {
                        unpatches.push(
                            instead(
                                "getOldestUnreadTimestamp",
                                ReadStateStore,
                                function (this: any, args: any[], orig: Function) {
                                    if (!botStorage.botClientMode) return orig.apply(this, args);
                                    return 0;
                                }
                            )
                        );
                    }
                }
            } catch {}
        }

        // F. EmojiStore: expose Application Emojis (matching VencordDBCPlugin:925)
        if (!emojiStorePatched) {
            try {
                const EmojiStore = findByStoreName("EmojiStore");
                if (EmojiStore && typeof EmojiStore.getGuilds === "function") {
                    emojiStorePatched = true;
                    unpatches.push(
                        after("getGuilds", EmojiStore, (_args: any[], guildsObj: any) => {
                            if (
                                !botStorage.botClientMode ||
                                !guildsObj ||
                                runtimeApplicationEmojis.length === 0
                            ) {
                                return guildsObj;
                            }
                            if (guildsObj["0"] && Array.isArray(guildsObj["0"].emojis)) {
                                guildsObj["0"].emojis = runtimeApplicationEmojis;
                            }
                            return guildsObj;
                        })
                    );
                }
            } catch {}
        }
    };

    activeEnsureBoundaryPatched = ensureBoundaryPatched;
    ensureBoundaryPatched();

    // Expose global BotClient API for console/UI/preload
    (globalThis as any).BotClient = {
        loginWithBotToken,
        logoutBotAccount,
        switchBotShard,
        getBotInfo,
        botStorage,
        patchReadyPayload,
        patchGuildCreatePayload,
        translateGatewayOutgoingFrame
    };

    unpatches.push(() => {
        if (autoLoginTimer !== null) {
            clearTimeout(autoLoginTimer);
            autoLoginTimer = null;
        }
    });

    const cleanup = () => {
        activeGatewayStoresUnpatch = null;
        activeEnsureBoundaryPatched = null;
        for (const u of unpatches) {
            try {
                u();
            } catch {}
        }
    };
    activeGatewayStoresUnpatch = cleanup;
    return cleanup;
}
