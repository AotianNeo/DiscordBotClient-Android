import { UserFlagsBitField } from "./bitfield";

export const DBC_VERSION = "3.9.3-android";
export const BOT_USER_AGENT = "DiscordBot (https://github.com/aiko-chan-ai/DiscordBotClient, v3.9.3)";

export const BLACKLIST_ROUTES = [
    "outbound-promotions/codes",
    "science",
    "applications/public",
    "notes",
    "member-ids",
    "connections/",
    "users/@me/disable",
    "users/@me/delete",
    "users/@me/mfa",
    "users/@me/phone",
    "interaction-data",
    "member-verification",
    "cdn-cgi/challenge-platform",
    "explicit-media",
    "premium/subscriptions",
    "/ack",
    "/stripe",
    "/paypal",
    "/validate-billing-address",
    "/custom-call-sounds",
    "auth/conditional/start"
];

export const SYSTEM_DM_CHANNEL_ID = "1000000000000000000";

export const DEFAULT_SETTINGS_PROTO_1 = "Cg8KBwoFZW4tVVMSAggBGAE=";
export const DEFAULT_SETTINGS_PROTO_2 = "";

export const NITRO_USER_PATCH = {
    premium: true,
    premium_type: 2,
    mfa_enabled: 1,
    authenticator_types: [] as number[],
    flags: 476111,
    public_flags: 476111,
    phone: "33550336",
    verified: true,
    nsfw_allowed: true,
    purchased_flags: 3
};

const BadgesData: Record<string, { id: string; description: string; icon: string; link?: string }> = {
    Staff: {
        id: "staff",
        description: "Discord Staff",
        icon: "5e74e9b61934fc1f67c65515d1f7e60d",
        link: "https://discord.com/company"
    },
    Partner: {
        id: "partner",
        description: "Partnered Server Owner",
        icon: "3f9748e53446a137a052f3454e2de41e",
        link: "https://discord.com/partners"
    },
    Hypesquad: {
        id: "hypesquad",
        description: "HypeSquad Events",
        icon: "bf01d1073931f921909045f3a39fd264",
        link: "https://discord.com/hypesquad"
    },
    BugHunterLevel1: {
        id: "bug_hunter_level_1",
        description: "Discord Bug Hunter",
        icon: "2717692c7dca7289b35297368a940dd0",
        link: "https://support.discord.com/hc/en-us/articles/360046057772-Discord-Bugs"
    },
    BugHunterLevel2: {
        id: "bug_hunter_level_2",
        description: "Discord Bug Hunter",
        icon: "848f79194d4be5ff5f81505cbd0ce1e6",
        link: "https://support.discord.com/hc/en-us/articles/360046057772-Discord-Bugs"
    },
    HypeSquadOnlineHouse1: {
        id: "hypesquad_online_house_1",
        description: "HypeSquad Bravery",
        icon: "8a88d63823d8a71cd5e390baa45efa02",
        link: "https://discord.com/settings/hypesquad-online"
    },
    HypeSquadOnlineHouse2: {
        id: "hypesquad_online_house_2",
        description: "HypeSquad Brilliance",
        icon: "011940fd013da3f7fb926e4a1cd2e618",
        link: "https://discord.com/settings/hypesquad-online"
    },
    HypeSquadOnlineHouse3: {
        id: "hypesquad_online_house_3",
        description: "HypeSquad Balance",
        icon: "3aa41de486fa12454c3761e8e223442e",
        link: "https://discord.com/settings/hypesquad-online"
    },
    PremiumEarlySupporter: {
        id: "early_supporter",
        description: "Early Supporter",
        icon: "7060786766c9c840eb3019e725d2b358",
        link: "https://discord.com/settings/premium"
    },
    VerifiedDeveloper: {
        id: "verified_developer",
        description: "Early Verified Bot Developer",
        icon: "6df5892e0f35b051f8b61eace34f4967"
    },
    CertifiedModerator: {
        id: "certified_moderator",
        description: "Moderator Programs Alumni",
        icon: "fee1624003e2fee35cb398e125dc479b",
        link: "https://discord.com/safety"
    },
    ActiveDeveloper: {
        id: "active_developer",
        description: "Active Developer",
        icon: "6bdc42827a38498929a4920da12695d9",
        link: "https://support-dev.discord.com/hc/en-us/articles/10113997751447?ref=badge"
    },
    BotHTTPInteractions: {
        id: "bot_commands",
        description: "Supports Commands",
        icon: "6f9e37f9029ff57aef81db857890005e",
        link: "https://discord.com/blog/welcome-to-the-new-era-of-discord-apps?ref=badge"
    }
};

export function createProfilePatch(
    userData: any,
    guildMemberData: any = null,
    guildId: string | null = null,
    bio: string | null = null
) {
    const flags = new UserFlagsBitField(userData?.flags ?? userData?.public_flags ?? 0);
    const badges = flags
        .toArray()
        .map(flag => BadgesData[flag])
        .filter(Boolean);

    if (userData?.bot) {
        badges.push(BadgesData.BotHTTPInteractions);
    }

    return {
        application: userData?.bot
            ? {
                  id: userData.id,
                  primary_sku_id: userData.id,
                  custom_install_url: `https://discord.com/oauth2/authorize?client_id=${userData.id}&scope=bot+applications.commands&permissions=8`,
                  install_params: {
                      scopes: ["bot", "applications.commands"],
                      permissions: "8"
                  }
              }
            : null,
        user: {
            ...userData,
            bio:
                bio ??
                userData?.bio ??
                `<a:shiggy:1162436090775470160> DiscordBotClient Android (${DBC_VERSION})`
        },
        user_profile: {
            bio:
                bio ??
                userData?.bio ??
                `<a:shiggy:1162436090775470160> DiscordBotClient Android (${DBC_VERSION})`,
            accent_color: userData?.accent_color ?? 5793266,
            pronouns: "",
            profile_effect: null,
            banner: userData?.banner ?? null,
            theme_colors: [5793266, 5793266],
            popout_animation_particle_type: null,
            emoji: null
        },
        connected_accounts: [],
        premium_since: "2016-12-22T00:00:00.000000+00:00",
        premium_type: 2,
        premium_guild_since: "2016-12-22T00:00:00.000000+00:00",
        mutual_friends: [],
        mutual_friends_count: 0,
        mutual_guilds: [],
        guild_member: guildMemberData ?? undefined,
        guild_member_profile:
            guildMemberData && guildId
                ? {
                      guild_id: guildId,
                      pronouns: "",
                      bio: "",
                      banner: guildMemberData.banner ?? null,
                      accent_color: null,
                      theme_colors: null,
                      popout_animation_particle_type: null,
                      emoji: null,
                      profile_effect: null
                  }
                : undefined,
        badges,
        guild_badges: [],
        legacy_username: userData?.discriminator && userData.discriminator !== "0"
            ? `${userData.username}#${userData.discriminator}`
            : userData?.username ?? "bot"
    };
}

export function createGuildProfileData(rawData: any) {
    return {
        id: rawData.id,
        name: rawData.name,
        icon_hash: rawData.icon,
        member_count: rawData.approximate_member_count || 999999,
        online_count: rawData.approximate_presence_count || 500000,
        description: rawData.description || "",
        banner_hash: rawData.banner,
        game_application_ids: [],
        SusActivityScore: {},
        tag: null,
        badge: 0,
        badge_color_primary: "#ff0000",
        badge_color_secondary: "#00ff00",
        badge_hash: null,
        traits: [],
        features: rawData.features || [],
        visibility: 2,
        custom_banner_hash: rawData.discovery_splash,
        premium_subscription_count: rawData.premium_subscription_count,
        premium_tier: rawData.premium_tier
    };
}

export function createWelcomeSystemMessage() {
    return [
        {
            id: "1000000000000000001",
            type: 0,
            content:
                `# Welcome to Revenge DiscordBotClient (Android)!\n` +
                `You are logged in with a **Discord Bot Token** on Android via **Revenge + DiscordBotClient (${DBC_VERSION})**.\n\n` +
                `### Features Active on Mobile\n` +
                `- **HTTP API Bot Interceptor**: Automatic \`Authorization: Bot <token>\`, User-Agent header, blacklisted endpoint blocking, profile synthesis, and channel/thread search translation.\n` +
                `- **Gateway & Sharding**: Automatic Privileged Intents negotiation, Shard switching, QoS heartbeat nulling (prevents error 4002), and Opcode 14 suppression.\n` +
                `- **Mobile Guild Member List**: Locally computed sidebar member groups via permission overwrite hashing.\n` +
                `- **Built-in Slash Commands**: Try \`/ping\`, \`/botinfo\`, \`/purge\`, \`/switch\`, and \`/embed\`.`,
            channel_id: SYSTEM_DM_CHANNEL_ID,
            author: {
                id: "1",
                username: "Revenge BotClient",
                discriminator: "0000",
                global_name: "Revenge BotClient",
                avatar: "cf37d42b1cbe7239ef6b55f8ce6a0b76",
                bot: true,
                system: true,
                public_flags: 65536
            },
            attachments: [],
            embeds: [],
            mentions: [],
            mention_roles: [],
            pinned: false,
            mention_everyone: false,
            tts: false,
            timestamp: new Date().toISOString(),
            edited_timestamp: null,
            flags: 0,
            components: []
        }
    ];
}
