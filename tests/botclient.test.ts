import { describe, expect, test } from "bun:test";
import {
    ApplicationFlags,
    computeBotIntents,
    GatewayIntentBits,
    IntentsBitField,
    murmurhash3_32_gc,
    SnowflakeUtil
} from "../src/core/plugins/botclient/bitfield";
import {
    createGuildProfileData,
    createProfilePatch,
    SYSTEM_DM_CHANNEL_ID
} from "../src/core/plugins/botclient/constants";
import {
    botStorage,
    cleanBotToken,
    formatBotAuthHeader,
    savePrivateChannel
} from "../src/core/plugins/botclient/storage";
import {
    handleBotApiRoute,
    mergeAndDedupeSettingsProto
} from "../src/core/plugins/botclient/apiInterceptor";
import {
    buildMemberListPayload,
    calculateMemberListId
} from "../src/core/plugins/botclient/memberList";
import {
    extractBotIdFromToken,
    patchGuildCreatePayload,
    patchReadyPayload,
    translateGatewayOutgoingFrame,
    wrapFastConnectModule
} from "../src/core/plugins/botclient/gatewayPatches";

describe("Revenge DiscordBotClient Android - Pure API & Gateway Boundary Verification", () => {
    test("computeBotIntents accurately maps ApplicationFlags to Gateway Intents", () => {
        const flags =
            ApplicationFlags.GatewayPresence |
            ApplicationFlags.GatewayGuildMembersLimited |
            ApplicationFlags.GatewayMessageContent;

        const res = computeBotIntents(flags);
        expect(res.hasPresence).toBe(true);
        expect(res.hasGuildMembers).toBe(true);
        expect(res.hasMessageContent).toBe(true);

        const bitfield = new IntentsBitField(res.intents);
        expect(bitfield.has(GatewayIntentBits.GuildPresences)).toBe(true);
        expect(bitfield.has(GatewayIntentBits.GuildMembers)).toBe(true);
        expect(bitfield.has(GatewayIntentBits.MessageContent)).toBe(true);
        expect(bitfield.has(GatewayIntentBits.Guilds)).toBe(true);
        expect(bitfield.has(GatewayIntentBits.DirectMessages)).toBe(true);
    });

    test("cleanBotToken and formatBotAuthHeader normalize Bot tokens", () => {
        expect(cleanBotToken("Bot MTIzNDU2.abc.def")).toBe("MTIzNDU2.abc.def");
        expect(cleanBotToken("  bot   MTIzNDU2.abc.def  ")).toBe("MTIzNDU2.abc.def");
        expect(formatBotAuthHeader("MTIzNDU2.abc.def")).toBe("Bot MTIzNDU2.abc.def");
        expect(formatBotAuthHeader("Bot MTIzNDU2.abc.def")).toBe("Bot MTIzNDU2.abc.def");
    });

    test("SnowflakeUtil generates and extracts Discord epoch timestamps", () => {
        const now = 1730000000000;
        const sf = SnowflakeUtil.generate(now);
        expect(typeof sf).toBe("string");
        expect(SnowflakeUtil.timestampFrom(sf)).toBe(now);
    });

    test("handleBotApiRoute serves exact OFFICIAL_STUBS schemas and passes Bot REST endpoints through", async () => {
        const ackRes = await handleBotApiRoute("POST", "https://discord.com/api/v9/channels/123/messages/456/ack");
        expect(ackRes.intercepted).toBe(true);
        expect(ackRes.status).toBe(200);
        expect(ackRes.body).toEqual({ token: null });

        const scienceRes = await handleBotApiRoute("POST", "/api/v10/science");
        expect(scienceRes.intercepted).toBe(true);
        expect(scienceRes.status).toBe(204);
        expect(scienceRes.body).toBeNull();

        const ackBulkRes = await handleBotApiRoute("POST", "/api/v9/read-states/ack-bulk");
        expect(ackBulkRes.intercepted).toBe(true);
        expect(ackBulkRes.status).toBe(204);
        expect(ackBulkRes.body).toBeNull();

        const sessionsRes = await handleBotApiRoute("GET", "/api/v9/auth/sessions");
        expect(sessionsRes.intercepted).toBe(true);
        expect(sessionsRes.status).toBe(200);
        expect(sessionsRes.body).toEqual({ user_sessions: [] });

        const collectiblesRes = await handleBotApiRoute("GET", "/api/v9/users/@me/collectibles-marketing");
        expect(collectiblesRes.intercepted).toBe(true);
        expect(collectiblesRes.body).toEqual({ marketings: {} });

        const savedMsgsRes = await handleBotApiRoute("GET", "/api/v9/users/@me/saved-messages");
        expect(savedMsgsRes.intercepted).toBe(true);
        expect(savedMsgsRes.body).toEqual({ results: [], reminders: [], bookmark_ids: [] });

        const inventoryRes = await handleBotApiRoute("GET", "/api/v9/content-inventory/users/@me");
        expect(inventoryRes.intercepted).toBe(true);
        expect(Array.isArray(inventoryRes.body.entries)).toBe(true);

        const arbitrateRes = await handleBotApiRoute("POST", "/api/v9/dismissible-content/arbitrate");
        expect(arbitrateRes.intercepted).toBe(true);
        expect(arbitrateRes.body).toEqual({ candidates: [] });

        // Real Bot REST routes must NOT be intercepted so they hit Discord API with Authorization: Bot
        const realMessages = await handleBotApiRoute("GET", "https://discord.com/api/v9/channels/987654321098765432/messages?limit=50");
        expect(realMessages.intercepted).toBe(false);

        const realSendMsg = await handleBotApiRoute("POST", "https://discord.com/api/v9/channels/987654321098765432/messages", { content: "hi" });
        expect(realSendMsg.intercepted).toBe(false);

        const realTyping = await handleBotApiRoute("POST", "https://discord.com/api/v9/channels/987654321098765432/typing");
        expect(realTyping.intercepted).toBe(false);

        const sysMsg = await handleBotApiRoute(
            "GET",
            `/api/v9/channels/${SYSTEM_DM_CHANNEL_ID}/messages`
        );
        expect(sysMsg.intercepted).toBe(true);
        expect(Array.isArray(sysMsg.body)).toBe(true);
        expect(sysMsg.body[0].channel_id).toBe(SYSTEM_DM_CHANNEL_ID);

        // Unknown user-only / unsupported API endpoints MUST be intercepted locally with HTTP 404 catch-all
        const unknownUserRoute = await handleBotApiRoute(
            "GET",
            "https://discord.com/api/v9/users/@me/some-unmapped-feature"
        );
        expect(unknownUserRoute.intercepted).toBe(true);
        expect(unknownUserRoute.status).toBe(404);
        expect(unknownUserRoute.ok).toBe(false);
        expect(unknownUserRoute.body).toEqual({ message: "404: Not Found", code: 0 });

        const unknownBillingRoute = await handleBotApiRoute(
            "POST",
            "/billing/google-play/verify-purchase",
            { token: "abc" }
        );
        expect(unknownBillingRoute.intercepted).toBe(true);
        expect(unknownBillingRoute.status).toBe(404);
        expect(unknownBillingRoute.body).toEqual({ message: "404: Not Found", code: 0 });

        // Static web assets on discord.com (not /api/) and CDN URLs must NOT be intercepted
        const staticAsset = await handleBotApiRoute(
            "GET",
            "https://discord.com/assets/123456abcdef.png"
        );
        expect(staticAsset.intercepted).toBe(false);

        const cdnAvatar = await handleBotApiRoute(
            "GET",
            "https://cdn.discordapp.com/avatars/123/abc.png"
        );
        expect(cdnAvatar.intercepted).toBe(false);
    });

    test("mergeAndDedupeSettingsProto deduplicates repeated field 14 (guild_folders)", () => {
        // Field 13 (0x6a = (13<<3)|2), len 2, [0x08, 0x02] -> base64 "agIIAg=="
        // Field 14 (0x72 = (14<<3)|2), len 2, [0x08, 0x01] -> bytes [0x72, 0x02, 0x08, 0x01] -> "cgIIAQ=="
        // Field 14 (0x72 = (14<<3)|2), len 2, [0x08, 0x09] -> bytes [0x72, 0x02, 0x08, 0x09] -> "cgII CQ==" ("cgIICQ==")
        const base = "agIIAg==";
        const firstPatch = mergeAndDedupeSettingsProto(1, base, "cgIIAQ==");
        const secondPatch = mergeAndDedupeSettingsProto(1, firstPatch, "cgIICQ==");

        const rawBytes = Buffer.from(secondPatch, "base64");
        // Expect field 13 (4 bytes: 6a 02 08 02) + ONLY the second field 14 (4 bytes: 72 02 08 09) = 8 bytes total!
        expect(rawBytes.length).toBe(8);
        expect(Array.from(rawBytes)).toEqual([0x6a, 0x02, 0x08, 0x02, 0x72, 0x02, 0x08, 0x09]);
    });

    test("patchGuildCreatePayload synthesizes guild.properties for Discord Android GuildStore", () => {
        botStorage.currentBotId = "123456789012345678";
        const rawBotGuildCreate: any = {
            id: "234567890123456789",
            name: "Alpha Test Guild",
            icon: "00112233445566778899aabbccddeeff",
            owner_id: "111",
            features: ["COMMUNITY"],
            channels: [{ id: "345678901234567890", name: "general", type: 0 }],
            roles: [{ id: "234567890123456789", name: "@everyone", permissions: "0" }],
            members: [
                {
                    user: { id: "123456789012345678", username: "ExampleBot", bot: true },
                    roles: []
                }
            ]
        };

        const patched = patchGuildCreatePayload(rawBotGuildCreate);
        expect(patched.properties).toBeDefined();
        expect(patched.properties.id).toBe("234567890123456789");
        expect(patched.properties.name).toBe("Alpha Test Guild");
        expect(patched.properties.channels).toBeUndefined();
        expect(patched.data_mode).toBe("full");
        expect(patched.roles[0].permissions).toBe("1099511627775");
        expect(patched.members[0].user.bot).toBe(false);
    });

    test("translateGatewayOutgoingFrame translates op=40 QoS heartbeat, cleans op=2 IDENTIFY, and drops op=14/37/41", () => {
        botStorage.currentToken = "MTIzNDU2Nzg5MDEyMzQ1Njc4.test.token";
        botStorage.currentShard = 0;
        botStorage.allShards = 1;

        // op=40 QoS Heartbeat -> op=1 standard Heartbeat
        const qosOut = translateGatewayOutgoingFrame(
            JSON.stringify({ op: 40, d: { seq: 42, qos: { ver: 26, active: true, reason: "foregrounded" } } })
        );
        expect(JSON.parse(qosOut as string)).toEqual({ op: 1, d: 42 });

        // op=2 IDENTIFY -> clean token, intents, shard, no capabilities/client_state
        const idOut = translateGatewayOutgoingFrame(
            JSON.stringify({
                op: 2,
                d: {
                    token: "Bot MTIzNDU2Nzg5MDEyMzQ1Njc4.test.token",
                    capabilities: 16381,
                    client_state: { guild_versions: {} },
                    properties: { os: "Android" }
                }
            })
        );
        const parsedId = JSON.parse(idOut as string);
        expect(parsedId.op).toBe(2);
        expect(parsedId.d.token).toBe("MTIzNDU2Nzg5MDEyMzQ1Njc4.test.token");
        expect(typeof parsedId.d.intents).toBe("number");
        expect(parsedId.d.shard).toEqual([0, 1]);
        expect(parsedId.d.capabilities).toBeUndefined();
        expect(parsedId.d.client_state).toBeUndefined();

        // op=14, op=37, op=41, and null-guild op=4 must be dropped (return null)
        expect(translateGatewayOutgoingFrame(JSON.stringify({ op: 14, d: { guild_id: "123" } }))).toBeNull();
        expect(translateGatewayOutgoingFrame(JSON.stringify({ op: 37, d: { subscriptions: {} } }))).toBeNull();
        expect(translateGatewayOutgoingFrame(JSON.stringify({ op: 41, d: {} }))).toBeNull();
        expect(translateGatewayOutgoingFrame(JSON.stringify({ op: 4, d: { guild_id: null, channel_id: null } }))).toBeNull();

        // op=8 multi-guild array unwrap
        const op8Out = translateGatewayOutgoingFrame(
            JSON.stringify({ op: 8, d: { guild_id: ["111", "222"], user_ids: ["999"] } })
        );
        expect(Array.isArray(op8Out)).toBe(true);
        expect((op8Out as string[]).length).toBe(2);
        expect(JSON.parse((op8Out as string[])[0]).d.guild_id).toBe("111");
    });

    test("patchReadyPayload spoofs bot=false, Nitro flags, and restores saved DM channels", () => {
        const botId = "999888777666555444";
        savePrivateChannel(botId, "111222333444555666", {
            id: "111222333444555666",
            type: 1,
            recipients: [
                {
                    id: "222333444555666777",
                    username: "friend_user",
                    discriminator: "0"
                }
            ]
        });

        const rawReady: any = {
            user: {
                id: botId,
                username: "TestBot",
                discriminator: "0001",
                bot: true
            },
            auth: {},
            consents: {},
            read_state: [],
            user_guild_settings: [],
            private_channels: [],
            users: []
        };

        const patched = patchReadyPayload(rawReady);
        expect(patched.user.bot).toBe(false);
        expect(patched.user.premium).toBe(true);
        expect(patched.user.premium_type).toBe(2);
        expect(patched.user.age_verification_status).toBe(3);
        expect(patched.user.authenticator_types).toEqual([]);
        expect(patched.auth.authenticator_types).toEqual([]);
        expect(patched.consents.personalization).toEqual({ consented: false });
        expect(patched.read_state).toEqual({ version: 0, partial: false, entries: [] });
        expect(patched.user_guild_settings).toEqual({ entries: [], version: 0, partial: false });

        const channelIds = patched.private_channels.map((c: any) => c.id);
        expect(channelIds).toContain(SYSTEM_DM_CHANNEL_ID);
        expect(channelIds).toContain("111222333444555666");

        const userIds = patched.users.map((u: any) => u.id);
        expect(userIds).toContain("222333444555666777");
        expect(userIds).toContain("1");
    });

    test("calculateMemberListId and buildMemberListPayload compute sidebar groups without Opcode 14", () => {
        const guildId = "100";
        const channel = {
            id: "200",
            permissionOverwrites: {
                "300": { id: "300", allow: (1n << 10n).toString(), deny: "0" }
            }
        };

        const listId = calculateMemberListId(channel, 1024n);
        expect(listId).not.toBe("everyone");
        expect(listId).toBe(murmurhash3_32_gc("allow:300").toString());

        const payload = buildMemberListPayload({
            guildId,
            channel: { id: "200", permissionOverwrites: {} },
            guildOwnerId: "u1",
            roles: {
                "100": { id: "100", name: "@everyone", permissions: (1n << 10n).toString(), position: 0, hoist: false },
                "r_admin": { id: "r_admin", name: "Admins", permissions: (1n << 3n).toString(), position: 5, hoist: true }
            },
            members: [
                { userId: "u1", roles: ["r_admin"], nick: "Boss" },
                { userId: "u2", roles: [], nick: "OnlineMember" },
                { userId: "u3", roles: [], nick: "OfflineMember" }
            ],
            presences: {
                u1: "online",
                u2: "dnd",
                u3: "offline"
            },
            users: {
                u1: { id: "u1", username: "boss" },
                u2: { id: "u2", username: "onlinemember" },
                u3: { id: "u3", username: "offlinemember" }
            }
        });

        expect(payload.id).toBe("everyone");
        expect(payload.memberCount).toBe(3);
        expect(payload.onlineCount).toBe(2);
        expect(payload.groups).toEqual([
            { id: "r_admin", count: 1 },
            { id: "online", count: 1 },
            { id: "offline", count: 1 }
        ]);
    });

    test("createProfilePatch and createGuildProfileData synthesize mobile-compatible profiles", () => {
        const profile = createProfilePatch(
            { id: "12345", username: "MyBot", discriminator: "0001", bot: true, flags: 1 << 16 },
            null,
            null,
            "Custom Bot Bio"
        );
        expect(profile.user.bio).toBe("Custom Bot Bio");
        expect(profile.premium_type).toBe(2);
        expect(profile.badges.some(b => b.id === "bot_commands")).toBe(true);

        const guildProfile = createGuildProfileData({
            id: "888",
            name: "Test Server",
            approximate_member_count: 120,
            approximate_presence_count: 45,
            features: ["COMMUNITY"]
        });
        expect(guildProfile.id).toBe("888");
        expect(guildProfile.member_count).toBe(120);
        expect(guildProfile.online_count).toBe(45);
    });

    test("wrapFastConnectModule translates warm-boot NativeFastConnectModule.prepareIdentify into pure Bot op=2 IDENTIFY", () => {
        const botToken = "MTIzNDU2Nzg5MDEyMzQ1Njc4.GTest0.test_hmac";
        expect(extractBotIdFromToken(botToken)).toBe("123456789012345678");

        botStorage.botClientMode = true;
        botStorage.bots = {
            "123456789012345678": {
                id: "123456789012345678",
                username: "ExampleBot",
                discriminator: "0001",
                avatar: null,
                token: botToken,
                currentShard: 0,
                allShards: 1,
                applicationFlags: 565248,
                intents: 53608447,
                guildCount: 2,
                addedAt: 1730000000000
            }
        };

        let capturedArgs: any[] = [];
        const rawFastConnect = {
            getConstants() {
                return { userId: "123456789012345678" };
            },
            prepareIdentify(
                userId: string | null,
                payload: string,
                socketId: number,
                requiredDbVersion: string
            ) {
                capturedArgs = [userId, payload, socketId, requiredDbVersion];
            }
        };

        const wrapped = wrapFastConnectModule(rawFastConnect);
        expect(wrapped.getConstants()).toEqual({ userId: "123456789012345678" });

        const rawUserFastConnectPayload = JSON.stringify({
            op: 2,
            d: {
                token: botToken,
                properties: {
                    os: "Android",
                    browser: "Discord Android",
                    device: "emu64a",
                    is_fast_connect: true
                },
                capabilities: 1734655,
                client_state: { guild_versions: {} },
                qos_token: "CgIIAQ=="
            }
        });

        wrapped.prepareIdentify("123456789012345678", rawUserFastConnectPayload, 0, "stable-301");

        // arg 0 (userId) MUST be null so Java FastConnectModule.sendIdentify skips IdentifyPayload.withGuildVersions
        expect(capturedArgs[0]).toBeNull();
        expect(capturedArgs[2]).toBe(0);
        expect(capturedArgs[3]).toBe("stable-301");

        const sentFrame = JSON.parse(capturedArgs[1]);
        expect(sentFrame.op).toBe(2);
        expect(sentFrame.d.token).toBe(botToken);
        expect(sentFrame.d.intents).toBe(53608447);
        expect(sentFrame.d.shard).toEqual([0, 1]);
        expect(sentFrame.d.capabilities).toBeUndefined();
        expect(sentFrame.d.client_state).toBeUndefined();
        expect(sentFrame.d.qos_token).toBeUndefined();
    });
});
