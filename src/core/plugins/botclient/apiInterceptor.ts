import { instead } from "@lib/api/patcher";
import { logger } from "@lib/utils/logger";
import { findByProps, findByStoreName } from "@metro/wrappers";
import { computeBotIntents, SnowflakeUtil } from "./bitfield";
import {
    BOT_USER_AGENT,
    createGuildProfileData,
    createProfilePatch,
    createWelcomeSystemMessage,
    NITRO_USER_PATCH,
    SYSTEM_DM_CHANNEL_ID
} from "./constants";
import {
    botStorage,
    cleanBotToken,
    formatBotAuthHeader,
    getSavedPrivateChannels,
    saveBotAccount,
    savePrivateChannel,
    setRuntimeApplicationEmojis
} from "./storage";

const originalFetch = globalThis.fetch?.bind(globalThis);

export interface BotInfoResult {
    success: boolean;
    message?: string;
    id?: string;
    username?: string;
    discriminator?: string;
    avatar?: string | null;
    bio?: string;
    flags?: number;
    intents: number;
    allShards: number;
    guildCount: number;
    hasPresence: boolean;
    hasGuildMembers: boolean;
    hasMessageContent: boolean;
}

export interface InterceptedRouteResult {
    intercepted: boolean;
    status: number;
    body: any;
    ok: boolean;
}

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64Bytes(b64: string): Uint8Array {
    if (typeof atob === "function") {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    if (typeof Buffer !== "undefined") {
        return new Uint8Array(Buffer.from(b64, "base64"));
    }
    const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
    const out: number[] = [];
    for (let i = 0; i < clean.length; i += 4) {
        const c0 = B64_CHARS.indexOf(clean[i]);
        const c1 = B64_CHARS.indexOf(clean[i + 1]);
        const c2 = i + 2 < clean.length ? B64_CHARS.indexOf(clean[i + 2]) : -1;
        const c3 = i + 3 < clean.length ? B64_CHARS.indexOf(clean[i + 3]) : -1;
        const n = (c0 << 18) | (c1 << 12) | ((c2 > 0 ? c2 : 0) << 6) | (c3 > 0 ? c3 : 0);
        out.push((n >>> 16) & 0xff);
        if (c2 >= 0) out.push((n >>> 8) & 0xff);
        if (c3 >= 0) out.push(n & 0xff);
    }
    return new Uint8Array(out);
}

function encodeBase64Bytes(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) {
        bin += String.fromCharCode(bytes[i]);
    }
    if (typeof btoa === "function") {
        return btoa(bin);
    }
    if (typeof Buffer !== "undefined") {
        return Buffer.from(bytes).toString("base64");
    }
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
        const n = (b0 << 16) | (b1 << 8) | b2;
        out += B64_CHARS[(n >>> 18) & 63];
        out += B64_CHARS[(n >>> 12) & 63];
        out += i + 1 < bytes.length ? B64_CHARS[(n >>> 6) & 63] : "=";
        out += i + 2 < bytes.length ? B64_CHARS[n & 63] : "=";
    }
    return out;
}

function protoVarint(bytes: Uint8Array, pos: number): [number, number] {
    let value = 0;
    for (let shift = 0; pos < bytes.length; shift += 7) {
        const b = bytes[pos++];
        value += (b & 0x7f) * 2 ** shift;
        if (!(b & 0x80)) return [value, pos];
    }
    throw new Error("truncated varint");
}

function keepLastTopLevelProtoFields(settingsBase64: string, replaceFields: number[]): string {
    if (!settingsBase64 || replaceFields.length === 0) return settingsBase64;
    const bytes = decodeBase64Bytes(settingsBase64);
    const spans: Array<[number, number, number]> = [];
    let pos = 0;
    while (pos < bytes.length) {
        const start = pos;
        const [key, p] = protoVarint(bytes, pos);
        const wire = key & 7;
        if (wire === 0) {
            pos = protoVarint(bytes, p)[1];
        } else if (wire === 1) {
            pos = p + 8;
        } else if (wire === 5) {
            pos = p + 4;
        } else if (wire === 2) {
            const [len, s0] = protoVarint(bytes, p);
            pos = s0 + len;
        } else {
            throw new Error(`unsupported wire type ${wire}`);
        }
        if (pos > bytes.length) {
            throw new Error("truncated protobuf field");
        }
        spans.push([key >>> 3, start, pos]);
    }
    const lastIdx = new Map<number, number>();
    spans.forEach(([field], idx) => {
        if (replaceFields.includes(field)) lastIdx.set(field, idx);
    });
    const kept = spans.filter(([field], idx) => !replaceFields.includes(field) || lastIdx.get(field) === idx);
    if (kept.length === spans.length) return settingsBase64;
    const out: number[] = [];
    for (const [, start, end] of kept) {
        for (let i = start; i < end; i++) out.push(bytes[i]);
    }
    return encodeBase64Bytes(new Uint8Array(out));
}

/**
 * Merges a protobuf settings patch onto stored settings while replacing top-level
 * repeated list fields such as `guild_folders` (field 14 in PreloadedUserSettings type 1)
 * so Discord's GuildsTree never throws `[GUILDS TREE] Tried adding a node that already exists`.
 * Ported directly from `discord-archive-client/pages/src/index.ts`.
 */
export function mergeAndDedupeSettingsProto(
    type: number,
    currentBase64: string,
    patchBase64: string
): string {
    if (!patchBase64) return currentBase64;
    const replaceFields = type === 1 ? [14] : [];
    try {
        // Validate patchBase64 is genuine protobuf wire bytes first
        keepLastTopLevelProtoFields(patchBase64, replaceFields);
        if (!currentBase64) return patchBase64;
        const a = decodeBase64Bytes(currentBase64);
        const b = decodeBase64Bytes(patchBase64);
        const joined = new Uint8Array(a.length + b.length);
        joined.set(a, 0);
        joined.set(b, a.length);
        const merged = keepLastTopLevelProtoFields(encodeBase64Bytes(joined), replaceFields);
        return merged.length <= 21848 ? merged : patchBase64;
    } catch {
        // Non-protobuf base64 test fixture or corrupted previous buffer: accept patch directly
        return patchBase64;
    }
}

/**
 * Direct REST call to Discord API v10 with Bot authorization header,
 * bypassing any patched interceptors via `X-DBC-Raw: 1`.
 */
export async function rawDiscordBotFetch(
    endpoint: string,
    token?: string,
    init: RequestInit = {}
): Promise<Response> {
    const activeToken = cleanBotToken(token || getActiveBotToken());
    const url = endpoint.startsWith("http")
        ? endpoint
        : `https://discord.com/api/v10${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;

    const headers = new Headers(init.headers || {});
    if (activeToken) {
        headers.set("Authorization", formatBotAuthHeader(activeToken));
    }
    headers.set("User-Agent", BOT_USER_AGENT);
    headers.set("X-DBC-Raw", "1");
    if (!headers.has("Content-Type") && init.body && typeof init.body === "string") {
        headers.set("Content-Type", "application/json");
    }
    headers.delete("X-Super-Properties");

    const fetchFn = originalFetch || fetch;
    return fetchFn(url, {
        ...init,
        headers
    });
}

function isMetroModuleZeroReady(): boolean {
    const win = (globalThis as any).window;
    if (!win || typeof win.__r === "undefined") {
        return true;
    }
    return Boolean(win.modules?.[0]?.isInitialized);
}

/**
 * Resolve the currently active Bot token from botStorage, preload global, AuthenticationStore, or TokenManager.
 */
export function getActiveBotToken(): string {
    if (botStorage.currentToken) {
        return cleanBotToken(botStorage.currentToken);
    }
    const preload = (globalThis as any).__BOTCLIENT_INITIAL_TOKEN__;
    if (preload && typeof preload === "string") {
        return cleanBotToken(preload);
    }
    if (!isMetroModuleZeroReady()) {
        return "";
    }
    try {
        const AuthStore = findByStoreName("AuthenticationStore");
        const authTok = AuthStore?.getToken?.();
        if (authTok) return cleanBotToken(authTok);
    } catch {
        // Ignore if Metro stores aren't ready yet
    }
    try {
        const tokenModule = findByProps("getToken", "setToken");
        const raw = tokenModule?.getToken?.();
        if (raw) return cleanBotToken(raw);
    } catch {
        // Ignore if Metro modules aren't ready yet
    }
    return "";
}

/**
 * Fetch Bot application metadata, compute allowed Gateway Intents and total shard count.
 * Mirrors DiscordBotClient IPCManager.getBotInfo & VencordDBCPlugin getBotInfo.
 */
export async function getBotInfo(token: string): Promise<BotInfoResult> {
    const cleanToken = cleanBotToken(token);
    if (!cleanToken) {
        return {
            success: false,
            message: "Empty Bot Token provided",
            intents: 0,
            allShards: 1,
            guildCount: 0,
            hasPresence: false,
            hasGuildMembers: false,
            hasMessageContent: false
        };
    }

    try {
        const [appRes, userRes] = await Promise.all([
            rawDiscordBotFetch("/applications/@me?with_counts=true", cleanToken),
            rawDiscordBotFetch("/users/@me", cleanToken)
        ]);

        if (!appRes.ok) {
            const errBody = await appRes.json().catch(() => ({}));
            return {
                success: false,
                message: errBody.message || `HTTP ${appRes.status}: Invalid Bot Token`,
                intents: 0,
                allShards: 1,
                guildCount: 0,
                hasPresence: false,
                hasGuildMembers: false,
                hasMessageContent: false
            };
        }

        const appData = await appRes.json();
        const userData = userRes.ok ? await userRes.json() : appData.bot || {};

        const flags = Number(appData.flags || 0);
        const guildCount = Number(appData.approximate_guild_count || 0);
        const guildsPerShard = Math.min(2500, Math.max(100, Number(botStorage.guildsPerShard) || 1000));
        const allShards = Math.max(1, Math.ceil(guildCount / guildsPerShard) || 1);

        const intentData = computeBotIntents(flags);
        const botId = userData.id || appData.id;

        if (botId) {
            const existing = botStorage.bots?.[botId];
            saveBotAccount({
                id: botId,
                username: userData.username || appData.name || "Bot",
                discriminator: userData.discriminator || "0000",
                globalName: userData.global_name || appData.name || null,
                avatar: userData.avatar ?? appData.icon ?? null,
                token: cleanToken,
                currentShard: existing ? Math.min(existing.currentShard, allShards - 1) : 0,
                allShards,
                applicationFlags: flags,
                intents: intentData.intents,
                guildCount,
                bio: appData.description || "",
                addedAt: existing?.addedAt || Date.now()
            });
        }

        return {
            success: true,
            id: botId,
            username: userData.username || appData.name,
            discriminator: userData.discriminator || "0000",
            avatar: userData.avatar ?? appData.icon ?? null,
            bio: appData.description || "",
            flags,
            intents: intentData.intents,
            allShards,
            guildCount,
            hasPresence: intentData.hasPresence,
            hasGuildMembers: intentData.hasGuildMembers,
            hasMessageContent: intentData.hasMessageContent
        };
    } catch (err: any) {
        return {
            success: false,
            message: err?.message || String(err),
            intents: 0,
            allShards: 1,
            guildCount: 0,
            hasPresence: false,
            hasGuildMembers: false,
            hasMessageContent: false
        };
    }
}

/**
 * Normalizes a URL or path into a clean API route path starting with `/`
 * (stripping `/api/v9`, `/api/v10`, `/api`).
 */
export function normalizeApiRoute(urlOrPath: string): {
    isDiscordApi: boolean;
    cleanPath: string;
    searchParams: URLSearchParams;
} {
    try {
        const isRelative = !urlOrPath.startsWith("http");
        const parsed = isRelative
            ? new URL(urlOrPath, "https://discord.com")
            : new URL(urlOrPath);

        const isDiscordHost =
            (parsed.hostname === "discord.com" ||
                parsed.hostname === "ptb.discord.com" ||
                parsed.hostname === "canary.discord.com" ||
                parsed.hostname === "discordapp.com" ||
                isRelative) &&
            !parsed.hostname.startsWith("cdn.") &&
            !parsed.hostname.startsWith("media.");

        const isApiPath =
            isRelative ||
            parsed.pathname === "/api" ||
            parsed.pathname.startsWith("/api/") ||
            parsed.pathname.startsWith("/cdn-cgi/");

        const apiMatch = parsed.pathname.match(/^(?:\/api(?:\/v\d+)?)?(\/.*)$/);
        const cleanPath = apiMatch ? apiMatch[1] : parsed.pathname;

        return {
            isDiscordApi: isDiscordHost && isApiPath,
            cleanPath,
            searchParams: parsed.searchParams
        };
    } catch {
        return {
            isDiscordApi: true,
            cleanPath: urlOrPath,
            searchParams: new URLSearchParams()
        };
    }
}

type StubFn = (match: RegExpMatchArray, searchParams: URLSearchParams, reqBody?: any) => any;
type StubEntry = [method: string, pattern: RegExp, body: StubFn | Record<string, any> | any[] | null, status?: number];

/**
 * Exact user-only endpoint stubs aligned with `discord-archive-client` (`OFFICIAL_STUBS`)
 * and `DiscordBotClient` (`src/AppCore/routes`).
 * Never return generic `[]` or `{}` for object/array-typed Flux actions.
 */
const OFFICIAL_STUBS: StubEntry[] = [
    // Write/Ack/Telemetry operations unsupported on Bot accounts
    ["POST", /^\/channels\/\d+\/messages\/\d+\/ack$/, { token: null }, 200],
    ["DELETE", /^\/channels\/\d+\/messages\/\d+\/ack$/, { token: null }, 200],
    ["POST", /^\/channels\/\d+\/pins\/ack$/, null, 204],
    ["POST", /^\/guilds\/\d+\/ack$/, null, 204],
    ["POST", /^\/users\/@me\/guild-events\/\d+\/ack$/, null, 204],
    ["POST", /^\/read-states\/ack-bulk$/, null, 204],
    ["PATCH", /^\/channels\/\d+\/explicit-media$/, null, 204],
    ["POST", /^\/users\/@me\/meaningfully-online$/, null, 204],
    ["*", /^\/users\/@me\/devices(\/.*)?$/, null, 204],
    ["*", /^\/users\/@me\/remote-auth(\/.*)?$/, null, 204],
    ["*", /^\/auth\/logout$/, null, 204],
    ["*", /^\/auth\/conditional\/start$/, { ticket: null }, 200],
    ["*", /^\/hypesquad\/online$/, null, 204],
    ["*", /^\/science$/, null, 204],
    ["POST", /^\/beaker$/, null, 204],
    ["POST", /^\/metrics$/, null, 204],
    ["POST", /^\/track$/, null, 204],
    ["POST", /^\/dismissible-content\/arbitrate$/, { candidates: [] }, 200],
    ["POST", /^\/guilds\/\d+\/migrate-command-scope$/, { integration_ids_with_app_commands: [] }, 200],
    [
        "*",
        /^\/guilds\/(\d+)\/onboarding-responses$/,
        (m, _sp, reqBody) => {
            const parsed =
                typeof reqBody === "string"
                    ? (() => {
                          try {
                              return JSON.parse(reqBody);
                          } catch {
                              return {};
                          }
                      })()
                    : reqBody || {};
            return {
                ...parsed,
                guild_id: m[1],
                user_id: botStorage.currentBotId || "0"
            };
        },
        200
    ],

    // Application commands / activities / directory (user-only endpoints)
    [
        "GET",
        /^\/(channels|guilds|users)\/(\d+|@me)\/application-command-index$/,
        () => ({ applications: [], application_commands: [], version: SnowflakeUtil.generate() }),
        200
    ],
    ["GET", /^\/channels\/\d+\/application-commands\/search$/, { application_commands: [], applications: [], cursor: null }, 200],
    ["GET", /^\/activities\/shelf$/, { activities: [], applications: [], assets: {} }, 200],
    ["GET", /^\/applications-with-assets$/, { applications: [], assets: {} }, 200],
    ["GET", /^\/application-directory-static\/collections$/, [], 200],
    ["GET", /^\/app-recommendations$/, [], 200],
    ["GET", /^\/applications\/(non-games\/)?detectable$/, [], 200],
    ["GET", /^\/applications\/public$/, [], 200],
    ["GET", /^\/games(\/detectable\/exclusions)?$/, [], 200],
    ["GET", /^\/applications\/\d+\/public$/, { message: "Unknown Application", code: 10002 }, 404],
    ["GET", /^\/oauth2\/tokens$/, [], 200],
    ["GET", /^\/teams$/, [], 200],
    ["GET", /^\/__development\/build_overrides$/, {}, 200],

    // Stickers / GIFs / Soundboard / Top Emojis
    ["GET", /^\/sticker-packs$/, { sticker_packs: [] }, 200],
    ["GET", /^\/gifs\/trending$/, { categories: [], gifs: [] }, 200],
    ["GET", /^\/gifs\/(search|trending-gifs|suggest|trending-search)$/, [], 200],
    ["GET", /^\/guilds\/\d+\/top-emojis$/, { items: [] }, 200],
    ["GET", /^\/guilds\/\d+\/soundboard-sounds$/, { items: [] }, 200],
    ["GET", /^\/soundboard-default-sounds$/, [], 200],

    // User-only Guild auxiliary endpoints (real Bot guild endpoints like /guilds/:id, /channels, /roles, /members, /bans, /invites, /webhooks, /emojis, /stickers pass through!)
    ["GET", /^\/guilds\/\d+\/admin-server-eligibility$/, { eligible_for_admin_server: false }, 200],
    ["GET", /^\/guilds\/\d+\/analytics\/member-insights$/, { has_access_rate: false, access_rate: null, last_updated: null }, 200],
    [
        "GET",
        /^\/guilds\/\d+\/(applications|entitlements|powerups|premium\/subscriptions|role-subscriptions\/group-listings|role-subscriptions\/trials)$/,
        [],
        200
    ],
    ["GET", /^\/guilds\/\d+\/products\/listings$/, { listings: [] }, 200],
    ["GET", /^\/guilds\/\d+\/top-games$/, { top_games: [] }, 200],
    [
        "GET",
        /^\/guilds\/(\d+)\/role-subscriptions\/settings$/,
        m => ({
            guild_id: m[1],
            full_server_gate: false,
            description: "",
            server_shop_tab_order: 0,
            store_page_primary_color: null,
            store_page_trailer_url: null,
            store_page_show_subscriber_count: false,
            store_page_guild_products_default_sort: 0,
            cover_image_asset: null,
            store_page_slug: null
        }),
        200
    ],
    [
        "GET",
        /^\/guilds\/(\d+)\/onboarding$/,
        m => ({
            guild_id: m[1],
            prompts: [],
            default_channel_ids: [],
            enabled: false,
            mode: 0,
            below_requirements: false,
            responses: []
        }),
        200
    ],
    ["GET", /^\/guilds\/\d+\/member-verification$/, { version: null, form_fields: [], description: null, guild: null }, 200],
    ["*", /^\/guilds\/\d+\/members\/@me\/member-ids$/, [], 200],
    ["GET", /^\/(users\/@me\/)?guilds\/integration-application-ids$/, {}, 200],
    ["GET", /^\/(users\/@me\/)?guilds\/premium\/(subscription-slots|subscriptions)$/, [], 200],
    ["GET", /^\/discoverable-guilds$/, { total: 0, guilds: [], offset: 0, limit: 100 }, 200],
    ["GET", /^\/discoverable-guilds\/search$/, { guilds: [], total_count: 0, categories: [] }, 200],
    ["GET", /^\/creator-monetization\/marketing\/nag-activate\/eligibility$/, { eligible_guilds: [] }, 200],

    // Current User (@me) user-only endpoints
    ["GET", /^\/users\/@me\/affinities\/guilds$/, { guild_affinities: [] }, 200],
    ["GET", /^\/users\/@me\/affinities\/users$/, { user_affinities: [], inverse_user_affinities: [] }, 200],
    ["GET", /^\/users\/@me\/affinities\/v2\/users$/, { user_affinities: [], other_user_affinities: [] }, 200],
    [
        "GET",
        /^\/users\/@me\/(relationships|connections|mentions|inventory|library|scheduled-messages|activities\/statistics\/applications|video-filters\/assets|mfa\/webauthn\/credentials|outbound-promotions\/codes|custom-call-sounds)$/,
        [],
        200
    ],
    ["*", /^\/users\/@me\/(disable|delete|mfa\/.*|phone(\/.*)?)$/, null, 204],
    ["GET", /^\/users\/@me\/applications\/\d+\/entitlements$/, [], 200],
    ["GET", /^\/users\/@me\/entitlements(\/gifts)?$/, [], 200],
    ["GET", /^\/users\/@me\/avatars$/, { avatars: [] }, 200],
    ["GET", /^\/users\/@me\/billing\/country-code$/, { country_code: "US" }, 200],
    ["GET", /^\/users\/@me\/billing\/location-info$/, { country_code: "US", subdivision_code: null }, 200],
    ["GET", /^\/users\/@me\/billing\/campaign-context$/, [{ campaign: 2, is_eligible: false }], 200],
    ["GET", /^\/users\/@me\/billing\/user-trial-offer$/, { user_trial_offer: null }, 200],
    ["GET", /^\/users\/@me\/billing\/(nitro-affinity|payment-sources|payments|subscriptions|invoices|trials)$/, [], 200],
    ["*", /^\/users\/@me\/billing\/(stripe|paypal|validate-billing-address)(\/.*)?$/, {}, 200],
    ["GET", /^\/users\/@me\/consent$/, { personalization: { consented: false }, usage_statistics: { consented: false } }, 200],
    ["GET", /^\/users\/@me\/custom-themes$/, null, 204],
    [
        "GET",
        /^\/users\/@me\/email-settings$/,
        {
            categories: {
                social: true,
                communication: true,
                recommendations_and_events: false,
                tips: false,
                updates_and_announcements: false
            },
            initialized: true
        },
        200
    ],
    ["GET", /^\/users\/@me\/gift-intent-dismissals$/, { dismissals: [] }, 200],
    ["GET", /^\/users\/@me\/harvest$/, null, 204],
    ["GET", /^\/users\/@me\/notes$/, {}, 200],
    ["GET", /^\/users\/@me\/notes\/\d+$/, { message: "Unknown User", code: 10013 }, 404],
    ["PUT", /^\/users\/@me\/notes\/\d+$/, null, 204],
    [
        "GET",
        /^\/users\/@me\/notification-center\/items$/,
        () => ({ limit: 20, items: [], cursor: SnowflakeUtil.generate(), has_more: false }),
        200
    ],
    ["GET", /^\/users\/@me\/program-rewards$/, { rewards: [] }, 200],
    [
        "GET",
        /^\/users\/@me\/referrals\/eligibility$/,
        {
            referrals_remaining: 0,
            sent_user_ids: [],
            refresh_at: null,
            has_eligible_friends: false,
            recipient_status: {},
            is_eligible_for_incentive: false,
            is_qualified_for_incentive: false,
            referral_incentive_status: 0
        },
        200
    ],
    ["GET", /^\/users\/@me\/referrals\/eligible-users$/, { users: [], next_index: 0 }, 200],
    ["GET", /^\/users\/@me\/referrals\/\d+\/preview$/, { is_eligible: false }, 200],
    ["GET", /^\/users\/@me\/saved-messages$/, { results: [], reminders: [], bookmark_ids: [] }, 200],
    ["GET", /^\/users\/@me\/survey$/, { survey: null }, 200],
    ["GET", /^\/users\/@me\/unclaimed-games$/, {}, 200],
    ["GET", /^\/users\/@me\/virtual-currency\/balance$/, { balance: 0 }, 200],
    ["GET", /^\/users\/@me\/widgets\/application-widget-application-ids$/, { application_configs: [] }, 200],
    ["GET", /^\/users\/@me\/widgets\/suggested-games$/, { suggested_games: [], suggested_wishlist_games: [] }, 200],
    ["GET", /^\/users\/(\d+|@me|%40me)\/badges$/, [], 200],
    ["GET", /^\/users\/(\d+|@me|%40me)\/badges\/\d+$/, { message: "Unknown Badge", code: 10000 }, 404],
    ["GET", /^\/users\/\d+\/relationships$/, [], 200],
    ["GET", /^\/family-center\/@me$/, { linked_users: [], users: [], teen_audit_log: null, age_group: "adult" }, 200],
    ["GET", /^\/safety-hub\/@me$/, { classifications: [], guild_classifications: [], account_standing: { state: 100 } }, 200],
    ["GET", /^\/auth\/location-metadata$/, { consent_required: false, country_code: "US", promotional_email_opt_in: { required: false, pre_checked: false } }, 200],
    ["GET", /^\/auth\/sessions$/, { user_sessions: [] }, 200],
    [
        "GET",
        /^\/content-inventory\/users\/@me$/,
        () => ({
            request_id: SnowflakeUtil.generate(),
            entries: [],
            entries_hash: 0,
            expired_at: new Date(Date.now() + 600_000).toISOString(),
            refresh_stale_inbox_after_ms: 3_000_000,
            refresh_token: "",
            wait_ms_until_next_fetch: 3_000_000
        }),
        200
    ],
    ["GET", /^\/content-inventory\/users\/\d+\/outbox$/, { entries: [] }, 200],
    ["GET", /^\/users\/\d+\/application-identities$/, { identities: [] }, 200],
    ["GET", /^\/widget-configs\/featured$/, { applications: [], configs: [] }, 200],

    // Shop / Nitro / Collectibles / Quests / Experiments
    ["GET", /^\/experiments$/, { fingerprint: "", assignments: [], guild_experiments: [] }, 200],
    ["GET", /^\/(users\/@me\/)?collectibles-marketing$/, { marketings: {} }, 200],
    ["GET", /^\/(users\/@me\/)?collectibles-purchases$/, [], 200],
    ["GET", /^\/collectibles-shop$/, { shop_blocks: [], categories: [] }, 200],
    ["GET", /^\/collectibles-categories$/, [], 200],
    ["GET", /^\/collectibles-categories\/v2$/, { categories: [], collections: [] }, 200],
    ["GET", /^\/premium-marketing$/, { sections: [], heroes: [] }, 200],
    ["GET", /^\/premium\/subscriptions$/, [], 200],
    ["GET", /^\/(bogo-)?promotions$/, [], 200],
    ["GET", /^\/outbound-promotions(\/codes)?$/, [], 200],
    ["GET", /^\/storefront\/promotions$/, { promotions: [] }, 200],
    ["GET", /^\/partner-sdk\/storefront-config$/, { promotional_sku_ids: [], promotion_end_datetime: null }, 200],
    ["GET", /^\/store\/published-listings\/skus$/, [], 200],
    ["GET", /^\/store\/published-listings\/(skus|applications)\/\d+\/subscription-plans$/, [], 200],
    ["GET", /^\/quests\/@me$/, { quests: [], excluded_quests: [], quest_enrollment_blocked_until: null }, 200],
    ["GET", /^\/quests\/@me\/claimed$/, { quests: [] }, 200],
    ["GET", /^\/quests\/decision$/, { quest: null }, 200],
    ["GET", /^\/quests\/get-decisions$/, () => ({ request_id: SnowflakeUtil.generate(), decisions: [] }), 200],
    ["GET", /^\/quests\/.*/, { quests: [], excluded_quests: [] }, 200],
    ["GET", /^\/streams\/[^/]+\/preview$/, { message: "Unknown Stream", code: 10049 }, 404],
    ["GET", /^\/changelogs\/config_\d+\.json$/, {}, 200],
    ["*", /^\/cdn-cgi\/challenge-platform(\/.*)?$/, null, 204]
];

function getDefaultWelcomePrivateChannel() {
    return {
        id: SYSTEM_DM_CHANNEL_ID,
        type: 1,
        last_message_id: "1000000000000000001",
        flags: 0,
        recipient_ids: ["1"],
        recipients: [
            {
                id: "1",
                username: "Revenge BotClient",
                discriminator: "0000",
                global_name: "Revenge BotClient",
                avatar: "cf37d42b1cbe7239ef6b55f8ce6a0b76",
                bot: true,
                system: true,
                public_flags: 65536
            }
        ]
    };
}

const BOT_SUPPORTED_API_PATTERNS: Array<[method: string, pattern: RegExp]> = [
    // Gateway, OAuth2, Applications
    ["GET", /^\/gateway(\/bot)?$/],
    ["*", /^\/oauth2\/(applications\/@me|@me)$/],
    ["*", /^\/applications\/(@me|\d+)(\/.*)?$/],

    // Current Bot User (@me) & User Lookup
    ["PATCH", /^\/users\/@me$/],
    ["GET", /^\/users\/@me\/guilds(\/\d+\/member)?$/],
    ["DELETE", /^\/users\/@me\/guilds\/\d+$/],
    ["GET", /^\/users\/\d+$/],

    // Channels: messages, pins, reactions, typing, permissions, invites, webhooks, threads, polls, soundboard
    ["GET", /^\/channels\/\d+$/],
    ["PATCH", /^\/channels\/\d+$/],
    ["DELETE", /^\/channels\/\d+$/],
    ["GET", /^\/channels\/\d+\/messages(\/\d+)?$/],
    ["POST", /^\/channels\/\d+\/messages$/],
    ["PATCH", /^\/channels\/\d+\/messages\/\d+$/],
    ["DELETE", /^\/channels\/\d+\/messages\/\d+$/],
    ["POST", /^\/channels\/\d+\/messages\/(\d+\/crosspost|bulk-delete)$/],
    ["*", /^\/channels\/\d+\/messages\/\d+\/reactions(\/.*)?$/],
    ["GET", /^\/channels\/\d+\/(pins|messages\/pins)$/],
    ["PUT", /^\/channels\/\d+\/(pins|messages\/pins)\/\d+$/],
    ["DELETE", /^\/channels\/\d+\/(pins|messages\/pins)\/\d+$/],
    ["POST", /^\/channels\/\d+\/typing$/],
    ["PUT", /^\/channels\/\d+\/permissions\/\d+$/],
    ["DELETE", /^\/channels\/\d+\/permissions\/\d+$/],
    ["GET", /^\/channels\/\d+\/invites$/],
    ["POST", /^\/channels\/\d+\/invites$/],
    ["POST", /^\/channels\/\d+\/followers$/],
    ["GET", /^\/channels\/\d+\/webhooks$/],
    ["POST", /^\/channels\/\d+\/webhooks$/],
    ["POST", /^\/channels\/\d+\/(messages\/\d+\/)?threads$/],
    ["*", /^\/channels\/\d+\/thread-members(\/.*)?$/],
    ["GET", /^\/channels\/\d+\/threads\/archived\/(public|private)$/],
    ["GET", /^\/channels\/\d+\/users\/@me\/threads\/archived\/private$/],
    ["GET", /^\/channels\/\d+\/polls\/\d+\/answers\/\d+$/],
    ["POST", /^\/channels\/\d+\/polls\/\d+\/expire$/],
    ["PUT", /^\/channels\/\d+\/recipients\/\d+$/],
    ["DELETE", /^\/channels\/\d+\/recipients\/\d+$/],
    ["POST", /^\/channels\/\d+\/send-soundboard-sound$/],

    // Guilds: metadata, channels, threads, members, roles, bans, invites, emojis, stickers, events, webhooks, audit-logs, automod
    ["POST", /^\/guilds$/],
    ["GET", /^\/guilds\/\d+(\/preview)?$/],
    ["PATCH", /^\/guilds\/\d+$/],
    ["DELETE", /^\/guilds\/\d+$/],
    ["*", /^\/guilds\/\d+\/channels$/],
    ["GET", /^\/guilds\/\d+\/threads\/active$/],
    ["*", /^\/guilds\/\d+\/members(\/(@me(\/nick)?|\d+(\/roles\/\d+)?|search))?$/],
    ["*", /^\/guilds\/\d+\/(bans(\/\d+)?|bulk-ban)$/],
    ["*", /^\/guilds\/\d+\/roles(\/(\d+|member-counts))?$/],
    ["*", /^\/guilds\/\d+\/prune$/],
    ["GET", /^\/guilds\/\d+\/(regions|invites|vanity-url|webhooks|audit-logs)$/],
    ["*", /^\/guilds\/\d+\/integrations(\/\d+)?$/],
    ["*", /^\/guilds\/\d+\/widget(\.json|-image)?$/],
    ["*", /^\/guilds\/\d+\/welcome-screen$/],
    ["*", /^\/guilds\/\d+\/voice-states\/(@me|\d+)$/],
    ["*", /^\/guilds\/\d+\/emojis(\/\d+)?$/],
    ["*", /^\/guilds\/\d+\/stickers(\/\d+)?$/],
    ["*", /^\/guilds\/\d+\/auto-moderation\/rules(\/\d+)?$/],
    ["*", /^\/guilds\/\d+\/scheduled-events(\/\d+(\/users)?)?$/],
    ["*", /^\/guilds\/\d+\/templates(\/[^/]+)?$/],
    ["*", /^\/guilds\/\d+\/soundboard-sounds(\/\d+)?$/],
    ["PUT", /^\/guilds\/\d+\/incident-actions$/],

    // Invites, Stage Instances, Stickers, Voice, Webhooks, Interactions Callback
    ["GET", /^\/invites\/[^/]+$/],
    ["DELETE", /^\/invites\/[^/]+$/],
    ["*", /^\/stage-instances(\/\d+)?$/],
    ["GET", /^\/stickers\/\d+$/],
    ["GET", /^\/sticker-packs(\/\d+)?$/],
    ["GET", /^\/voice\/regions$/],
    ["*", /^\/webhooks\/\d+(\/[^/]+(\/messages\/(@original|\d+))?)?$/],
    ["POST", /^\/interactions\/\d+\/[^/]+\/callback$/]
];

export function isSupportedBotRestRoute(upperMethod: string, cleanPath: string): boolean {
    for (const [m, pattern] of BOT_SUPPORTED_API_PATTERNS) {
        if (m !== "*" && m !== upperMethod) continue;
        if (pattern.test(cleanPath)) return true;
    }
    return false;
}

const UNKNOWN_ROUTE_404_RESULT: InterceptedRouteResult = {
    intercepted: true,
    status: 404,
    body: { message: "404: Not Found", code: 0 },
    ok: false
};

/**
 * Synchronous fast-path evaluator for ~95% of routes (`OFFICIAL_STUBS`, `settings-proto`,
 * welcome DM, saved DMs, passthrough Bot REST routes, and `404` catch-all for unknown endpoints).
 * Returns `"ASYNC"` only for routes requiring `rawDiscordBotFetch` synthesis.
 */
function evaluateSyncBotApiRoute(
    upperMethod: string,
    cleanPath: string,
    searchParams: URLSearchParams,
    requestBody?: any
): InterceptedRouteResult | "ASYNC" {
    // 1. Exact OFFICIAL_STUBS match
    for (const [m, pattern, body, status] of OFFICIAL_STUBS) {
        if (m !== "*" && m !== upperMethod) continue;
        const match = cleanPath.match(pattern);
        if (!match) continue;
        const resolvedBody =
            typeof body === "function" ? (body as StubFn)(match, searchParams, requestBody) : body;
        const code = status ?? 200;
        return {
            intercepted: true,
            status: code,
            body: resolvedBody,
            ok: code >= 200 && code < 300
        };
    }

    // 2. System Welcome Channel messages
    if (upperMethod === "GET" && cleanPath === `/channels/${SYSTEM_DM_CHANNEL_ID}/messages`) {
        return {
            intercepted: true,
            status: 200,
            body: createWelcomeSystemMessage(),
            ok: true
        };
    }

    // 3. Settings Proto 1 & 2 (with keepLastTopLevel field-14 guild_folders deduplication)
    const protoMatch = cleanPath.match(/^\/users\/@me\/settings-proto\/([12])$/);
    if (protoMatch) {
        const protoType = Number(protoMatch[1]);
        const key = protoType === 1 ? "settingsProto1" : "settingsProto2";
        if (upperMethod === "GET") {
            return {
                intercepted: true,
                status: 200,
                body: { settings: botStorage[key] },
                ok: true
            };
        }
        if (upperMethod === "PATCH") {
            const incoming =
                typeof requestBody === "string"
                    ? (() => {
                          try {
                              return JSON.parse(requestBody || "{}");
                          } catch {
                              return {};
                          }
                      })()
                    : requestBody || {};
            if (typeof incoming.settings === "string" && incoming.settings.length > 0) {
                botStorage[key] = mergeAndDedupeSettingsProto(
                    protoType,
                    botStorage[key],
                    incoming.settings
                );
            }
            return {
                intercepted: true,
                status: 200,
                body: { settings: botStorage[key] },
                ok: true
            };
        }
    }

    // 4. GET / PATCH /users/@me/settings (legacy user settings fallback)
    if ((upperMethod === "GET" || upperMethod === "PATCH") && cleanPath === "/users/@me/settings") {
        const patchObj =
            upperMethod === "PATCH" && requestBody
                ? typeof requestBody === "string"
                    ? (() => {
                          try {
                              return JSON.parse(requestBody);
                          } catch {
                              return {};
                          }
                      })()
                    : requestBody
                : {};
        return {
            intercepted: true,
            status: 200,
            body: {
                locale: "zh-CN",
                theme: "dark",
                render_embeds: true,
                render_reactions: true,
                animate_emoji: true,
                enable_tts_command: false,
                message_display_compact: false,
                inline_attachment_media: true,
                inline_embed_media: true,
                gif_auto_play: true,
                status: "online",
                custom_status: null,
                ...patchObj
            },
            ok: true
        };
    }

    // 5. GET /users/@me/channels -> Saved DM channels + System Welcome DM
    if (upperMethod === "GET" && cleanPath === "/users/@me/channels") {
        const saved = Object.values(getSavedPrivateChannels(botStorage.currentBotId));
        return {
            intercepted: true,
            status: 200,
            body: [getDefaultWelcomePrivateChannel(), ...saved],
            ok: true
        };
    }

    // 6. Routes requiring async Bot REST synthesis
    if (
        (upperMethod === "POST" && cleanPath === "/auth/login") ||
        (upperMethod === "GET" && cleanPath === "/users/@me") ||
        (upperMethod === "GET" && cleanPath === "/users/@me/emojis") ||
        (upperMethod === "POST" && cleanPath === "/users/@me/channels") ||
        (upperMethod === "GET" &&
            botStorage.generateFakeProfile &&
            /^\/users\/([^/]+)\/profile$/.test(cleanPath)) ||
        (upperMethod === "GET" && /^\/(channels|guilds)\/\d+\/messages\/search$/.test(cleanPath)) ||
        (upperMethod === "GET" && /^\/channels\/\d+\/threads\/search$/.test(cleanPath)) ||
        (upperMethod === "GET" && /^\/guilds\/\d+\/profile$/.test(cleanPath))
    ) {
        return "ASYNC";
    }

    // 7. Legitimate Discord Bot REST v9/v10 routes pass straight through with Authorization: Bot <token>
    if (isSupportedBotRestRoute(upperMethod, cleanPath)) {
        return { intercepted: false, status: 200, body: null, ok: true };
    }

    // 8. Local 404 catch-all for any unknown user-only Discord API endpoint (prevents 401/403 logout & unhandled schema crashes)
    logger.log(`[BotClient] 404 fallback for unknown route: ${upperMethod} ${cleanPath}`);
    return UNKNOWN_ROUTE_404_RESULT;
}

/**
 * Evaluates whether a route matches DiscordBotClient's APIServer + OFFICIAL_STUBS rules and returns
 * either a mocked/transformed response or `{ intercepted: false }` to pass through
 * with `Authorization: Bot <token>`.
 */
export async function handleBotApiRoute(
    method: string,
    urlOrPath: string,
    requestBody?: any,
    queryObj?: Record<string, any>
): Promise<InterceptedRouteResult> {
    const upperMethod = method.toUpperCase();
    const { isDiscordApi, cleanPath, searchParams } = normalizeApiRoute(urlOrPath);

    if (!isDiscordApi) {
        return { intercepted: false, status: 200, body: null, ok: true };
    }

    if (queryObj && typeof queryObj === "object") {
        for (const [k, v] of Object.entries(queryObj)) {
            if (v !== undefined && v !== null) {
                searchParams.set(k, String(v));
            }
        }
    }

    const syncRes = evaluateSyncBotApiRoute(upperMethod, cleanPath, searchParams, requestBody);
    if (syncRes !== "ASYNC") {
        return syncRes;
    }

    // Async synthesis route 0: POST /auth/login -> Native Discord Login screen Bot Token support
    if (upperMethod === "POST" && cleanPath === "/auth/login") {
        const parsed =
            typeof requestBody === "string"
                ? (() => {
                      try {
                          return JSON.parse(requestBody);
                      } catch {
                          return {};
                      }
                  })()
                : requestBody || {};
        const candidate = cleanBotToken(String(parsed.login || ""));
        if (/^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/.test(candidate)) {
            const info = await getBotInfo(candidate);
            if (!info.success) {
                return {
                    intercepted: true,
                    status: 400,
                    body: {
                        message: "Invalid Form Body",
                        code: 50035,
                        errors: {
                            login: {
                                _errors: [
                                    {
                                        code: "INVALID_LOGIN",
                                        message: info.message || "Invalid Bot Token."
                                    }
                                ]
                            }
                        }
                    },
                    ok: false
                };
            }
            botStorage.botClientMode = true;
            botStorage.currentToken = candidate;
            botStorage.currentBotId = info.id || "";
            botStorage.allShards = info.allShards;
            return {
                intercepted: true,
                status: 200,
                body: {
                    token: candidate,
                    user_id: info.id,
                    user_settings: {
                        locale: "zh-CN",
                        theme: "dark"
                    }
                },
                ok: true
            };
        }
        return { intercepted: false, status: 200, body: null, ok: true };
    }

    // Async synthesis route 1: GET /users/@me -> Fetch real bot user and patch Nitro & bot: false
    if (upperMethod === "GET" && cleanPath === "/users/@me") {
        const res = await rawDiscordBotFetch("/users/@me");
        const data = await res.json().catch(() => ({}));
        if (res.ok && data?.id) {
            return {
                intercepted: true,
                status: 200,
                body: {
                    ...data,
                    ...NITRO_USER_PATCH,
                    bot: false,
                    age_verification_status: 3,
                    email: `${data.id}@cyrene.moe`
                },
                ok: true
            };
        }
        return { intercepted: true, status: res.status, body: data, ok: res.ok };
    }

    // Async synthesis route 2: POST /users/@me/channels -> Translate { recipients: [id] } to Bot API { recipient_id: id }
    if (upperMethod === "POST" && cleanPath === "/users/@me/channels") {
        const parsed =
            typeof requestBody === "string"
                ? (() => {
                      try {
                          return JSON.parse(requestBody);
                      } catch {
                          return {};
                      }
                  })()
                : requestBody || {};
        const recipientId =
            parsed.recipient_id ||
            (Array.isArray(parsed.recipients) ? parsed.recipients[0] : undefined);
        if (!recipientId) {
            return {
                intercepted: true,
                status: 400,
                body: { message: "Missing recipient_id", code: 50035 },
                ok: false
            };
        }
        const res = await rawDiscordBotFetch("/users/@me/channels", undefined, {
            method: "POST",
            body: JSON.stringify({ recipient_id: String(recipientId) })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data?.id) {
            savePrivateChannel(botStorage.currentBotId, data.id, data);
        }
        return { intercepted: true, status: res.status, body: data, ok: res.ok };
    }

    // Async synthesis route 3: GET /users/@me/emojis -> Redirect to /applications/:id/emojis
    if (upperMethod === "GET" && cleanPath === "/users/@me/emojis") {
        let appId = botStorage.currentBotId;
        if (!appId) {
            const meRes = await rawDiscordBotFetch("/users/@me");
            if (meRes.ok) {
                const me = await meRes.json().catch(() => ({}));
                appId = me.id;
            }
        }
        if (!appId) {
            return { intercepted: true, status: 200, body: [], ok: true };
        }
        const emojiRes = await rawDiscordBotFetch(`/applications/${appId}/emojis`);
        if (!emojiRes.ok) {
            return { intercepted: true, status: 200, body: [], ok: true };
        }
        const emojiData = await emojiRes.json().catch(() => ({}));
        const items = (emojiData?.items || []).map((e: any) => ({
            ...e,
            allNamesString: `:${e.name}:`,
            guildId: "0",
            type: 1
        }));
        setRuntimeApplicationEmojis(items);
        return {
            intercepted: true,
            status: 200,
            body: items,
            ok: true
        };
    }

    // Async synthesis route 4: GET /users/:id/profile -> Synthesize ProfilePatch from /users/:id + /guilds/:gid/members/:uid
    const profileMatch = cleanPath.match(/^\/users\/([^/]+)\/profile$/);
    if (upperMethod === "GET" && profileMatch && botStorage.generateFakeProfile) {
        const rawTarget = decodeURIComponent(profileMatch[1]);
        const targetId = rawTarget === "@me" ? botStorage.currentBotId || "@me" : rawTarget;
        const guildId = searchParams.get("guild_id");

        if (targetId === "1") {
            return {
                intercepted: true,
                status: 200,
                body: createProfilePatch(
                    getDefaultWelcomePrivateChannel().recipients[0],
                    null,
                    guildId,
                    "Revenge DiscordBotClient Android System Channel"
                ),
                ok: true
            };
        }

        const userRes = await rawDiscordBotFetch(
            targetId === "@me" ? "/users/@me" : `/users/${targetId}`
        );
        if (!userRes.ok) {
            const err = await userRes.json().catch(() => ({}));
            return { intercepted: true, status: userRes.status, body: err, ok: false };
        }
        const userData = await userRes.json();

        let guildMemberData = null;
        if (guildId && userData?.id) {
            const memberRes = await rawDiscordBotFetch(
                `/guilds/${guildId}/members/${userData.id}`
            );
            if (memberRes.ok) {
                guildMemberData = await memberRes.json();
            }
        }

        let bio = null;
        if (rawTarget === "@me" || userData?.id === botStorage.currentBotId) {
            bio = botStorage.bots?.[botStorage.currentBotId]?.bio || null;
        }

        return {
            intercepted: true,
            status: 200,
            body: createProfilePatch(userData, guildMemberData, guildId, bio),
            ok: true
        };
    }

    // Async synthesis route 5: GET /channels/:id/messages/search or /guilds/:id/messages/search
    const channelSearchMatch = cleanPath.match(/^\/channels\/(\d+)\/messages\/search$/);
    const guildSearchMatch = cleanPath.match(/^\/guilds\/(\d+)\/messages\/search$/);
    if (upperMethod === "GET" && (channelSearchMatch || guildSearchMatch)) {
        const channelId = channelSearchMatch
            ? channelSearchMatch[1]
            : searchParams.get("channel_id");

        if (!channelId) {
            return {
                intercepted: true,
                status: 200,
                body: {
                    analytics_id: SnowflakeUtil.generate(),
                    doing_deep_historical_index: false,
                    total_results: 0,
                    messages: []
                },
                ok: true
            };
        }

        const msgRes = await rawDiscordBotFetch(`/channels/${channelId}/messages?limit=50`);
        if (!msgRes.ok) {
            return {
                intercepted: true,
                status: 200,
                body: {
                    analytics_id: SnowflakeUtil.generate(),
                    doing_deep_historical_index: false,
                    total_results: 0,
                    messages: []
                },
                ok: true
            };
        }

        const messages = await msgRes.json().catch(() => []);
        const queryText = (searchParams.get("content") || "").toLowerCase();
        const authorFilter = searchParams.get("author_id");
        const filtered = Array.isArray(messages)
            ? messages.filter((m: any) => {
                  if (authorFilter && m?.author?.id !== authorFilter) return false;
                  return queryText ? (m?.content || "").toLowerCase().includes(queryText) : true;
              })
            : [];

        return {
            intercepted: true,
            status: 200,
            body: {
                analytics_id: SnowflakeUtil.generate(),
                doing_deep_historical_index: false,
                total_results: filtered.length,
                messages: filtered.map((m: any) => [{ ...m, hit: true }])
            },
            ok: true
        };
    }

    // Async synthesis route 6: GET /channels/:id/threads/search
    const threadSearchMatch = cleanPath.match(/^\/channels\/(\d+)\/threads\/search$/);
    if (upperMethod === "GET" && threadSearchMatch) {
        const channelId = threadSearchMatch[1];
        const archivedRes = await rawDiscordBotFetch(
            `/channels/${channelId}/threads/archived/public`
        );
        if (!archivedRes.ok) {
            return {
                intercepted: true,
                status: 200,
                body: {
                    threads: [],
                    members: [],
                    has_more: false,
                    total_results: 0,
                    first_messages: []
                },
                ok: true
            };
        }
        const data = await archivedRes.json().catch(() => ({}));
        const threads = data?.threads || [];
        return {
            intercepted: true,
            status: 200,
            body: {
                threads,
                members: data?.members || [],
                has_more: data?.has_more || false,
                total_results: threads.length,
                first_messages: []
            },
            ok: true
        };
    }

    // Async synthesis route 7: GET /guilds/:id/profile -> Transform from /guilds/:id?with_counts=true
    const guildProfileMatch = cleanPath.match(/^\/guilds\/(\d+)\/profile$/);
    if (upperMethod === "GET" && guildProfileMatch) {
        const guildId = guildProfileMatch[1];
        const guildRes = await rawDiscordBotFetch(`/guilds/${guildId}?with_counts=true`);
        if (!guildRes.ok) {
            const err = await guildRes.json().catch(() => ({}));
            return { intercepted: true, status: guildRes.status, body: err, ok: false };
        }
        const rawGuild = await guildRes.json();
        return {
            intercepted: true,
            status: 200,
            body: createGuildProfileData(rawGuild),
            ok: true
        };
    }

    if (isSupportedBotRestRoute(upperMethod, cleanPath)) {
        return { intercepted: false, status: 200, body: null, ok: true };
    }
    return UNKNOWN_ROUTE_404_RESULT;
}

function completeMockedReactNativeXhr(xhr: any, result: InterceptedRouteResult): void {
    const isNoContent = result.status === 204 || result.status === 205 || result.body === null;
    const bodyText = isNoContent ? "" : JSON.stringify(result.body);
    const respHeaders = isNoContent ? {} : { "content-type": "application/json" };

    // Native React Native XMLHttpRequest path (verified on Discord Android 351011 Hermes runtime):
    // setResponseHeaders + _response + setReadyState(2 -> 3 -> 4) fires all EventTarget listeners AND on* properties.
    if (typeof xhr.setReadyState === "function") {
        try {
            xhr.status = result.status;
            xhr.responseURL = xhr.__dbcUrl || "";
            if (typeof xhr.setResponseHeaders === "function") {
                xhr.setResponseHeaders(respHeaders);
            } else {
                xhr.responseHeaders = respHeaders;
            }
            xhr._response = bodyText;
            xhr._hasError = false;
            xhr.setReadyState(2);
            if (!isNoContent) {
                xhr.setReadyState(3);
            }
            xhr.setReadyState(4);
            return;
        } catch (err) {
            logger.error("[BotClient] RN XHR setReadyState error:", err);
        }
    }

    // Fallback for non-RN XHR environments (e.g., Bun/Node unit tests)
    try {
        Object.defineProperty(xhr, "readyState", { value: 4, configurable: true });
        Object.defineProperty(xhr, "status", { value: result.status, configurable: true });
        Object.defineProperty(xhr, "statusText", { value: result.ok ? "OK" : "Error", configurable: true });
        Object.defineProperty(xhr, "responseText", { value: bodyText, configurable: true });
        Object.defineProperty(xhr, "response", { value: bodyText, configurable: true });
        xhr.getAllResponseHeaders = () => (isNoContent ? "" : "content-type: application/json\r\n");
        xhr.getResponseHeader = (h: string) =>
            !isNoContent && h?.toLowerCase() === "content-type" ? "application/json" : null;
    } catch {}
    const makeEvt = (type: string) => ({ type, target: xhr, currentTarget: xhr });
    try {
        if (typeof xhr.dispatchEvent === "function") {
            xhr.dispatchEvent(makeEvt("readystatechange"));
            xhr.dispatchEvent(makeEvt("load"));
            xhr.dispatchEvent(makeEvt("loadend"));
        } else {
            xhr.onreadystatechange?.(makeEvt("readystatechange"));
            xhr.onload?.(makeEvt("load"));
            xhr.onloadend?.(makeEvt("loadend"));
        }
    } catch {}
}

let activeHttpInterceptorsUnpatch: (() => void) | null = null;
let activeTryEagerHttpPatch: (() => void) | null = null;

function patchHttpUtilsTarget(target: any, unpatches: Array<() => void>): boolean {
    if (!target || (typeof target !== "object" && typeof target !== "function")) return false;
    if (target.__dbcHttpPatched) return true;
    const required = ["get", "post", "put", "patch"] as const;
    if (!required.every(m => typeof target[m] === "function")) return false;
    if (typeof target.del !== "function" && typeof target.delete !== "function") return false;

    Object.defineProperty(target, "__dbcHttpPatched", {
        value: true,
        configurable: true,
        enumerable: false
    });

    const methods = ["get", "post", "put", "patch", "del", "delete"] as const;
    for (const method of methods) {
        if (typeof target[method] !== "function") continue;

        const unpatch = instead(method, target, async (args: any[], orig: Function) => {
            if (!botStorage.botClientMode) {
                return orig.apply(target, args);
            }

            const reqConfig =
                typeof args[0] === "string"
                    ? { url: args[0], ...(args[1] || {}) }
                    : { ...(args[0] || {}) };

            const url = reqConfig.url || "";
            const httpMethod = method === "del" ? "DELETE" : method.toUpperCase();

            try {
                const result = await handleBotApiRoute(
                    httpMethod,
                    url,
                    reqConfig.body,
                    reqConfig.query
                );
                if (result.intercepted) {
                    const isNoContent =
                        result.status === 204 || result.status === 205 || result.body === null;
                    const responseObj = {
                        ok: result.ok,
                        status: result.status,
                        headers: isNoContent ? {} : { "content-type": "application/json" },
                        body: result.body,
                        text: isNoContent ? "" : JSON.stringify(result.body)
                    };
                    if (!result.ok) {
                        return Promise.reject(responseObj);
                    }
                    return responseObj;
                }
            } catch (err) {
                logger.error("[BotClient] HTTP route handler error:", err);
            }

            const activeToken = getActiveBotToken();
            const cleanHeaders: Record<string, any> = { ...(reqConfig.headers || {}) };
            delete cleanHeaders["X-Super-Properties"];
            delete cleanHeaders["x-super-properties"];
            if (activeToken) {
                cleanHeaders.Authorization = formatBotAuthHeader(activeToken);
                cleanHeaders["User-Agent"] = BOT_USER_AGENT;
            }
            reqConfig.headers = cleanHeaders;

            if (typeof args[0] === "string") {
                return orig.call(target, url, reqConfig);
            }
            return orig.call(target, reqConfig, ...args.slice(1));
        });

        unpatches.push(unpatch);
    }

    unpatches.push(() => {
        delete target.__dbcHttpPatched;
    });
    return true;
}

/**
 * Installs HTTP API boundary interceptors on:
 * 1. Discord's Metro `HTTPUtils.HTTP` (`get`, `post`, `put`, `patch`, `del`, `delete`)
 * 2. `globalThis.fetch`
 * 3. `globalThis.XMLHttpRequest.prototype`
 */
export function patchHttpInterceptors(): () => void {
    if (activeHttpInterceptorsUnpatch) {
        activeTryEagerHttpPatch?.();
        return activeHttpInterceptorsUnpatch;
    }

    const unpatches: Array<() => void> = [];
    let httpUtilsPatched = false;

    const tryEagerHttpPatch = () => {
        if (httpUtilsPatched || !isMetroModuleZeroReady()) return;
        try {
            const httpModule =
                findByProps("HTTP", "get", "post") ||
                findByProps("get", "post", "put", "patch", "del");
            const target = httpModule?.HTTP || httpModule;
            if (patchHttpUtilsTarget(target, unpatches)) {
                httpUtilsPatched = true;
            }
        } catch (err) {
            logger.error("[BotClient] Failed to patch HTTPUtils:", err);
        }
    };

    activeTryEagerHttpPatch = tryEagerHttpPatch;

    // 1. Hook Metro module load so HTTPUtils.HTTP is patched synchronously during metroRequire(0)
    try {
        const { registerModuleLoadHook } = require("@metro/internals/modules");
        if (typeof registerModuleLoadHook === "function") {
            unpatches.push(
                registerModuleLoadHook((moduleExports: any) => {
                    if (httpUtilsPatched || !moduleExports) return;
                    const candidates: any[] = [moduleExports];
                    for (const key of Object.getOwnPropertyNames(moduleExports)) {
                        const desc = Object.getOwnPropertyDescriptor(moduleExports, key);
                        if (desc && "value" in desc && desc.value) {
                            candidates.push(desc.value);
                            if (typeof desc.value === "object" && desc.value.HTTP) {
                                candidates.push(desc.value.HTTP);
                            }
                        }
                    }
                    for (const cand of candidates) {
                        if (patchHttpUtilsTarget(cand, unpatches)) {
                            httpUtilsPatched = true;
                            break;
                        }
                    }
                })
            );
        }
    } catch {}

    tryEagerHttpPatch();

    // 2. Patch globalThis.fetch
    if (typeof globalThis.fetch === "function") {
        const unpatchFetch = instead("fetch", globalThis, async (args: any[], orig: Function) => {
            if (!botStorage.botClientMode) {
                return orig.apply(globalThis, args);
            }

            const [input, init = {}] = args;
            const reqHeaders = new Headers(init?.headers || (typeof input === "object" ? input?.headers : undefined) || {});
            if (reqHeaders.get("X-DBC-Raw") === "1") {
                reqHeaders.delete("X-DBC-Raw");
                return orig.call(globalThis, input, { ...init, headers: reqHeaders });
            }

            const url = typeof input === "string" ? input : input?.url || String(input);
            const method = (init?.method || (typeof input === "object" && input?.method) || "GET").toUpperCase();

            const { isDiscordApi } = normalizeApiRoute(url);
            if (!isDiscordApi) {
                return orig.apply(globalThis, args);
            }

            try {
                const intercepted = await handleBotApiRoute(method, url, init?.body);
                if (intercepted.intercepted) {
                    const isNullBodyStatus =
                        intercepted.status === 204 ||
                        intercepted.status === 205 ||
                        intercepted.status === 304;
                    return new Response(
                        isNullBodyStatus ? null : JSON.stringify(intercepted.body),
                        {
                            status: intercepted.status,
                            headers: isNullBodyStatus ? {} : { "Content-Type": "application/json" }
                        }
                    );
                }
            } catch (err) {
                logger.error("[BotClient] fetch interceptor error:", err);
            }

            const activeToken = getActiveBotToken();
            const existingAuth = reqHeaders.get("Authorization");
            if (existingAuth && !existingAuth.startsWith("Bot ")) {
                reqHeaders.set("Authorization", formatBotAuthHeader(existingAuth));
            } else if (!existingAuth && activeToken) {
                reqHeaders.set("Authorization", formatBotAuthHeader(activeToken));
            }
            reqHeaders.set("User-Agent", BOT_USER_AGENT);
            reqHeaders.delete("X-Super-Properties");

            return orig.call(globalThis, input, {
                ...init,
                headers: reqHeaders
            });
        });
        unpatches.push(unpatchFetch);
    }

    // 3. Patch XMLHttpRequest.prototype (used by superagent / React Native Networking)
    if (typeof globalThis.XMLHttpRequest !== "undefined") {
        const xhrProto = globalThis.XMLHttpRequest.prototype as any;
        const nativeSetRequestHeader = xhrProto.setRequestHeader;

        const unpatchOpen = instead(
            "open",
            xhrProto,
            function (this: any, args: any[], orig: Function) {
                this.__dbcMethod = (args[0] || "GET").toUpperCase();
                this.__dbcUrl = String(args[1] || "");
                this.__dbcHeaders = {};
                return orig.apply(this, args);
            }
        );

        const unpatchSetHeader = instead(
            "setRequestHeader",
            xhrProto,
            function (this: any, args: [string, string], orig: Function) {
                const [header, value] = args;
                const lower = String(header || "").toLowerCase();
                this.__dbcHeaders = this.__dbcHeaders || {};

                if (lower === "x-dbc-raw") {
                    this.__dbcHeaders["x-dbc-raw"] = "1";
                    return;
                }

                if (!botStorage.botClientMode) {
                    return orig.apply(this, args);
                }

                const { isDiscordApi } = normalizeApiRoute(this.__dbcUrl || "");
                if (!isDiscordApi) {
                    return orig.apply(this, args);
                }

                if (lower === "x-super-properties") {
                    return;
                }

                if (lower === "authorization") {
                    const formatted = formatBotAuthHeader(value || getActiveBotToken());
                    this.__dbcHeaders.authorization = formatted;
                    return orig.call(this, header, formatted);
                }

                if (lower === "user-agent") {
                    this.__dbcHeaders["user-agent"] = BOT_USER_AGENT;
                    return orig.call(this, header, BOT_USER_AGENT);
                }

                return orig.apply(this, args);
            }
        );

        const attachBotHeadersAndSend = (xhr: any, origSend: Function, sendArgs: any[]) => {
            try {
                if (!xhr.__dbcHeaders?.authorization) {
                    const activeToken = getActiveBotToken();
                    if (activeToken) {
                        const formatted = formatBotAuthHeader(activeToken);
                        xhr.__dbcHeaders = xhr.__dbcHeaders || {};
                        xhr.__dbcHeaders.authorization = formatted;
                        nativeSetRequestHeader.call(xhr, "Authorization", formatted);
                    }
                }
                if (!xhr.__dbcHeaders?.["user-agent"]) {
                    xhr.__dbcHeaders = xhr.__dbcHeaders || {};
                    xhr.__dbcHeaders["user-agent"] = BOT_USER_AGENT;
                    nativeSetRequestHeader.call(xhr, "User-Agent", BOT_USER_AGENT);
                }
            } catch {}
            return origSend.apply(xhr, sendArgs);
        };

        const unpatchSend = instead(
            "send",
            xhrProto,
            function (this: any, args: any[], orig: Function) {
                if (!botStorage.botClientMode || !this.__dbcUrl || this.__dbcHeaders?.["x-dbc-raw"] === "1") {
                    return orig.apply(this, args);
                }

                const { isDiscordApi, cleanPath, searchParams } = normalizeApiRoute(this.__dbcUrl);
                if (!isDiscordApi) {
                    return orig.apply(this, args);
                }

                const reqBody = args[0];
                const upperMethod = this.__dbcMethod || "GET";

                // Fast synchronous path: zero microtask delay for all OFFICIAL_STUBS and real Bot passthrough routes!
                const syncResult = evaluateSyncBotApiRoute(upperMethod, cleanPath, searchParams, reqBody);
                if (syncResult !== "ASYNC") {
                    if (syncResult.intercepted) {
                        const xhr = this;
                        setTimeout(() => completeMockedReactNativeXhr(xhr, syncResult), 0);
                        return;
                    }
                    return attachBotHeadersAndSend(this, orig, args);
                }

                // Async synthesis path (profile card, @me, DM creation, message/thread search)
                const xhr = this;
                handleBotApiRoute(upperMethod, this.__dbcUrl, reqBody)
                    .then(result => {
                        if (result.intercepted) {
                            completeMockedReactNativeXhr(xhr, result);
                            return;
                        }
                        attachBotHeadersAndSend(xhr, orig, args);
                    })
                    .catch(() => {
                        attachBotHeadersAndSend(xhr, orig, args);
                    });
            }
        );

        unpatches.push(unpatchOpen, unpatchSetHeader, unpatchSend);
    }

    const cleanup = () => {
        activeHttpInterceptorsUnpatch = null;
        activeTryEagerHttpPatch = null;
        for (const u of unpatches) {
            try {
                u();
            } catch {
                // Ignore cleanup error
            }
        }
    };
    activeHttpInterceptorsUnpatch = cleanup;
    return cleanup;
}
