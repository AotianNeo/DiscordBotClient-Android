export class BitField<T extends string> {
    public bitfield: number;
    public static Flags: Record<string, number> = {};

    constructor(bits: number | string | BitField<T> | Array<number | string | T> = 0) {
        this.bitfield = (this.constructor as typeof BitField).resolve(bits);
    }

    any(bit: number | string | T | BitField<T> | Array<number | string | T>): boolean {
        return (this.bitfield & (this.constructor as typeof BitField).resolve(bit)) !== 0;
    }

    equals(bit: number | string | T | BitField<T>): boolean {
        return this.bitfield === (this.constructor as typeof BitField).resolve(bit);
    }

    has(bit: number | string | T | BitField<T> | Array<number | string | T>): boolean {
        const resolved = (this.constructor as typeof BitField).resolve(bit);
        return (this.bitfield & resolved) === resolved;
    }

    add(...bits: Array<number | string | T | BitField<T>>): this {
        let total = 0;
        for (const bit of bits) {
            total |= (this.constructor as typeof BitField).resolve(bit);
        }
        this.bitfield |= total;
        return this;
    }

    remove(...bits: Array<number | string | T | BitField<T>>): this {
        let total = 0;
        for (const bit of bits) {
            total |= (this.constructor as typeof BitField).resolve(bit);
        }
        this.bitfield &= ~total;
        return this;
    }

    toArray(): string[] {
        const flags = (this.constructor as typeof BitField).Flags;
        return Object.keys(flags).filter(bit => this.has(bit));
    }

    static resolve(bit: any): number {
        if (typeof bit === "number" && bit >= 0) return bit;
        if (bit instanceof BitField) return bit.bitfield;
        if (Array.isArray(bit)) {
            return bit.map(p => this.resolve(p)).reduce((prev, p) => prev | p, 0);
        }
        if (typeof bit === "string") {
            if (!isNaN(Number(bit))) return Number(bit);
            if (this.Flags[bit] !== undefined) return this.Flags[bit];
        }
        return 0;
    }
}

export const ApplicationFlags = {
    ApplicationAutoModerationRuleCreateBadge: 1 << 6,
    GatewayPresence: 1 << 12,
    GatewayPresenceLimited: 1 << 13,
    GatewayGuildMembers: 1 << 14,
    GatewayGuildMembersLimited: 1 << 15,
    VerificationPendingGuildLimit: 1 << 16,
    Embedded: 1 << 17,
    GatewayMessageContent: 1 << 18,
    GatewayMessageContentLimited: 1 << 19,
    ApplicationCommandBadge: 1 << 23
} as const;

export type ApplicationFlagsKey = keyof typeof ApplicationFlags;

export class ApplicationFlagsBitField extends BitField<ApplicationFlagsKey> {
    static override Flags = ApplicationFlags;
}

export const GatewayIntentBits = {
    Guilds: 1 << 0,
    GuildMembers: 1 << 1,
    GuildModeration: 1 << 2,
    GuildBans: 1 << 2,
    GuildEmojisAndStickers: 1 << 3,
    GuildIntegrations: 1 << 4,
    GuildWebhooks: 1 << 5,
    GuildInvites: 1 << 6,
    GuildVoiceStates: 1 << 7,
    GuildPresences: 1 << 8,
    GuildMessages: 1 << 9,
    GuildMessageReactions: 1 << 10,
    GuildMessageTyping: 1 << 11,
    DirectMessages: 1 << 12,
    DirectMessageReactions: 1 << 13,
    DirectMessageTyping: 1 << 14,
    MessageContent: 1 << 15,
    GuildScheduledEvents: 1 << 16,
    AutoModerationConfiguration: 1 << 20,
    AutoModerationExecution: 1 << 21,
    GuildMessagePolls: 1 << 24,
    DirectMessagePolls: 1 << 25
} as const;

export type GatewayIntentKey = keyof typeof GatewayIntentBits;

export class IntentsBitField extends BitField<GatewayIntentKey> {
    static override Flags = GatewayIntentBits;
}

export const UserFlags = {
    Staff: 1 << 0,
    Partner: 1 << 1,
    Hypesquad: 1 << 2,
    BugHunterLevel1: 1 << 3,
    HypeSquadOnlineHouse1: 1 << 6,
    HypeSquadOnlineHouse2: 1 << 7,
    HypeSquadOnlineHouse3: 1 << 8,
    PremiumEarlySupporter: 1 << 9,
    TeamPseudoUser: 1 << 10,
    BugHunterLevel2: 1 << 14,
    VerifiedBot: 1 << 16,
    VerifiedDeveloper: 1 << 17,
    CertifiedModerator: 1 << 18,
    BotHTTPInteractions: 1 << 19,
    ActiveDeveloper: 1 << 22
} as const;

export type UserFlagsKey = keyof typeof UserFlags;

export class UserFlagsBitField extends BitField<UserFlagsKey> {
    static override Flags = UserFlags;
}

export class SnowflakeUtil {
    static readonly EPOCH = 1420070400000;
    private static INCREMENT = 0;

    static generate(timestamp: number | Date = Date.now()): string {
        if (timestamp instanceof Date) timestamp = timestamp.getTime();
        const inc = (this.INCREMENT = (this.INCREMENT + 1) & 0xfff);
        const timeBits = BigInt(timestamp - this.EPOCH) << 22n;
        const workerBits = 1n << 17n;
        const processBits = 0n << 12n;
        const incBits = BigInt(inc);
        return (timeBits | workerBits | processBits | incBits).toString();
    }

    static timestampFrom(snowflake: string): number {
        try {
            return Number((BigInt(snowflake) >> 22n) + BigInt(this.EPOCH));
        } catch {
            return Date.now();
        }
    }
}

/**
 * MurmurHash3 32-bit implementation used by Discord to compute member_list_id
 * from permission overwrites.
 */
export function murmurhash3_32_gc(key: string, seed = 0): number {
    const remainder = key.length & 3;
    const bytes = key.length - remainder;
    let h1 = seed;
    const c1 = 0xcc9e2d51;
    const c2 = 0x1b873593;
    let i = 0;

    while (i < bytes) {
        let k1 =
            (key.charCodeAt(i) & 0xff) |
            ((key.charCodeAt(++i) & 0xff) << 8) |
            ((key.charCodeAt(++i) & 0xff) << 16) |
            ((key.charCodeAt(++i) & 0xff) << 24);
        ++i;

        k1 = ((k1 & 0xffff) * c1 + ((((k1 >>> 16) * c1) & 0xffff) << 16)) & 0xffffffff;
        k1 = (k1 << 15) | (k1 >>> 17);
        k1 = ((k1 & 0xffff) * c2 + ((((k1 >>> 16) * c2) & 0xffff) << 16)) & 0xffffffff;

        h1 ^= k1;
        h1 = (h1 << 13) | (h1 >>> 19);
        const h1b = ((h1 & 0xffff) * 5 + ((((h1 >>> 16) * 5) & 0xffff) << 16)) & 0xffffffff;
        h1 = (h1b & 0xffff) + 0x6b64 + ((((h1b >>> 16) + 0xe654) & 0xffff) << 16);
    }

    let k1 = 0;
    switch (remainder) {
        case 3:
            k1 ^= (key.charCodeAt(i + 2) & 0xff) << 16;
        // fallthrough
        case 2:
            k1 ^= (key.charCodeAt(i + 1) & 0xff) << 8;
        // fallthrough
        case 1:
            k1 ^= key.charCodeAt(i) & 0xff;
            k1 = ((k1 & 0xffff) * c1 + ((((k1 >>> 16) * c1) & 0xffff) << 16)) & 0xffffffff;
            k1 = (k1 << 15) | (k1 >>> 17);
            k1 = ((k1 & 0xffff) * c2 + ((((k1 >>> 16) * c2) & 0xffff) << 16)) & 0xffffffff;
            h1 ^= k1;
    }

    h1 ^= key.length;
    h1 ^= h1 >>> 16;
    h1 = ((h1 & 0xffff) * 0x85ebca6b + ((((h1 >>> 16) * 0x85ebca6b) & 0xffff) << 16)) & 0xffffffff;
    h1 ^= h1 >>> 13;
    h1 = ((h1 & 0xffff) * 0xc2b2ae35 + ((((h1 >>> 16) * 0xc2b2ae35) & 0xffff) << 16)) & 0xffffffff;
    h1 ^= h1 >>> 16;

    return h1 >>> 0;
}

/**
 * Compute valid Bot Gateway Intents from ApplicationFlagsBitField
 * Mirrors DiscordBotClient IPCManager.getBotInfo
 */
export function computeBotIntents(flags: number | string): {
    intents: number;
    hasPresence: boolean;
    hasGuildMembers: boolean;
    hasMessageContent: boolean;
} {
    const appFlags = new ApplicationFlagsBitField(flags);
    const hasPresence = appFlags.any([
        ApplicationFlags.GatewayPresence,
        ApplicationFlags.GatewayPresenceLimited
    ]);
    const hasGuildMembers = appFlags.any([
        ApplicationFlags.GatewayGuildMembers,
        ApplicationFlags.GatewayGuildMembersLimited
    ]);
    const hasMessageContent = appFlags.any([
        ApplicationFlags.GatewayMessageContent,
        ApplicationFlags.GatewayMessageContentLimited
    ]);

    const intents = new IntentsBitField([
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildEmojisAndStickers,
        GatewayIntentBits.GuildIntegrations,
        GatewayIntentBits.GuildWebhooks,
        GatewayIntentBits.GuildInvites,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMessageTyping,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
        GatewayIntentBits.DirectMessageTyping,
        GatewayIntentBits.GuildScheduledEvents,
        GatewayIntentBits.AutoModerationConfiguration,
        GatewayIntentBits.AutoModerationExecution,
        GatewayIntentBits.GuildMessagePolls,
        GatewayIntentBits.DirectMessagePolls
    ]);

    if (hasPresence) intents.add(GatewayIntentBits.GuildPresences);
    if (hasGuildMembers) intents.add(GatewayIntentBits.GuildMembers);
    if (hasMessageContent) intents.add(GatewayIntentBits.MessageContent);

    return {
        intents: intents.bitfield,
        hasPresence,
        hasGuildMembers,
        hasMessageContent
    };
}
