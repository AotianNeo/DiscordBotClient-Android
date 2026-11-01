import { logger } from "@lib/utils/logger";
import { findByProps, findByStoreName } from "@metro/wrappers";
import { throttle } from "es-toolkit";
import { murmurhash3_32_gc } from "./bitfield";
import { botStorage } from "./storage";

const VIEW_CHANNEL_PERMISSION = 1n << 10n;
const ADMINISTRATOR_PERMISSION = 1n << 3n;

export interface MemberListGroupItem {
    group?: { id: string; count: number; title?: string };
    member?: {
        user: { id: string; username?: string; avatar?: string | null; bot?: boolean };
        roles: string[];
        nick?: string | null;
        premium_since?: string | null;
        joined_at?: string;
        status?: string;
    };
}

/**
 * Computes Discord's deterministic `member_list_id` for a channel based on its
 * `VIEW_CHANNEL` permission overwrites.
 * If everyone can view or no overwrites affect VIEW_CHANNEL, returns "everyone".
 */
export function calculateMemberListId(
    channel: any,
    everyoneRolePermissions?: bigint | string | number
): string {
    const overwrites = channel?.permissionOverwrites
        ? Object.values(channel.permissionOverwrites)
        : Array.isArray(channel?.permission_overwrites)
          ? channel.permission_overwrites
          : [];

    const history: string[] = [];

    for (const overwrite of overwrites as any[]) {
        const allow = BigInt(overwrite.allow ?? 0);
        const deny = BigInt(overwrite.deny ?? 0);

        if ((allow & VIEW_CHANNEL_PERMISSION) !== 0n) {
            history.push(`allow:${overwrite.id}`);
        } else if ((deny & VIEW_CHANNEL_PERMISSION) !== 0n) {
            history.push(`deny:${overwrite.id}`);
        }
    }

    if (history.length === 0) {
        if (everyoneRolePermissions !== undefined) {
            const perms = BigInt(everyoneRolePermissions);
            if (
                (perms & VIEW_CHANNEL_PERMISSION) !== 0n ||
                (perms & ADMINISTRATOR_PERMISSION) !== 0n
            ) {
                return "everyone";
            }
        } else {
            return "everyone";
        }
    }

    return murmurhash3_32_gc(history.sort().join(",")).toString();
}

/**
 * Builds groups and sorted member items for `GUILD_MEMBER_LIST_UPDATE`.
 */
export function buildMemberListPayload(params: {
    guildId: string;
    channel: any;
    guildOwnerId?: string;
    roles: Record<string, any>;
    members: Array<any>;
    presences: Record<string, string>;
    users?: Record<string, any>;
}) {
    const { guildId, channel, guildOwnerId, roles, members, presences, users = {} } = params;
    const everyoneRole = roles[guildId];
    const memberListId = calculateMemberListId(channel, everyoneRole?.permissions);

    // Sort hoisted roles by position descending
    const hoistedRoles = Object.values(roles)
        .filter((r: any) => r && r.hoist && r.id !== guildId)
        .sort((a: any, b: any) => (b.position ?? 0) - (a.position ?? 0));

    const roleBuckets = new Map<string, any[]>();
    for (const r of hoistedRoles) {
        roleBuckets.set(r.id, []);
    }
    const onlineBucket: any[] = [];
    const offlineBucket: any[] = [];

    const canViewChannel = (member: any): boolean => {
        const userId = member.userId || member.user?.id;
        if (!userId) return false;
        if (guildOwnerId && userId === guildOwnerId) return true;

        let perms = BigInt(everyoneRole?.permissions ?? VIEW_CHANNEL_PERMISSION);
        const memberRoles: string[] = Array.isArray(member.roles) ? member.roles : [];

        for (const rId of memberRoles) {
            const role = roles[rId];
            if (role?.permissions !== undefined) {
                perms |= BigInt(role.permissions);
            }
        }

        if ((perms & ADMINISTRATOR_PERMISSION) !== 0n) return true;

        const overwrites = channel?.permissionOverwrites || {};
        const owEveryone = overwrites[guildId];
        if (owEveryone) {
            perms &= ~BigInt(owEveryone.deny ?? 0);
            perms |= BigInt(owEveryone.allow ?? 0);
        }

        let roleDeny = 0n;
        let roleAllow = 0n;
        for (const rId of memberRoles) {
            const owRole = overwrites[rId];
            if (owRole) {
                roleDeny |= BigInt(owRole.deny ?? 0);
                roleAllow |= BigInt(owRole.allow ?? 0);
            }
        }
        perms &= ~roleDeny;
        perms |= roleAllow;

        const owMember = overwrites[userId];
        if (owMember) {
            perms &= ~BigInt(owMember.deny ?? 0);
            perms |= BigInt(owMember.allow ?? 0);
        }

        return (perms & VIEW_CHANNEL_PERMISSION) !== 0n;
    };

    for (const m of members) {
        const userId = m.userId || m.user?.id;
        if (!userId) continue;
        if (!canViewChannel(m)) continue;

        const status = presences[userId] || "offline";
        const isOnline = status !== "offline" && status !== "invisible";
        const userObj = m.user || users[userId] || { id: userId, username: m.nick || userId };

        const entry = {
            member: {
                user: userObj,
                roles: Array.isArray(m.roles) ? m.roles : [],
                nick: m.nick ?? null,
                premium_since: m.premiumSince ?? m.premium_since ?? null,
                joined_at: m.joinedAt ?? m.joined_at ?? new Date().toISOString(),
                status
            }
        };

        if (!isOnline) {
            offlineBucket.push(entry);
            continue;
        }

        let placedInHoist = false;
        if (m.hoistRoleId && roleBuckets.has(m.hoistRoleId)) {
            roleBuckets.get(m.hoistRoleId)!.push(entry);
            placedInHoist = true;
        } else {
            for (const hr of hoistedRoles) {
                if (entry.member.roles.includes(hr.id)) {
                    roleBuckets.get(hr.id)!.push(entry);
                    placedInHoist = true;
                    break;
                }
            }
        }

        if (!placedInHoist) {
            onlineBucket.push(entry);
        }
    }

    const sortByName = (a: any, b: any) => {
        const nameA = (a.member.nick || a.member.user?.global_name || a.member.user?.username || "").toLowerCase();
        const nameB = (b.member.nick || b.member.user?.global_name || b.member.user?.username || "").toLowerCase();
        return nameA.localeCompare(nameB);
    };

    const groups: Array<{ id: string; count: number }> = [];
    const listItems: MemberListGroupItem[] = [];

    for (const hr of hoistedRoles) {
        const bucket = roleBuckets.get(hr.id) || [];
        if (bucket.length > 0) {
            bucket.sort(sortByName);
            groups.push({ id: hr.id, count: bucket.length });
            listItems.push({ group: { id: hr.id, count: bucket.length } }, ...bucket);
        }
    }

    if (onlineBucket.length > 0) {
        onlineBucket.sort(sortByName);
        groups.push({ id: "online", count: onlineBucket.length });
        listItems.push({ group: { id: "online", count: onlineBucket.length } }, ...onlineBucket);
    }

    if (offlineBucket.length > 0) {
        offlineBucket.sort(sortByName);
        groups.push({ id: "offline", count: offlineBucket.length });
        listItems.push({ group: { id: "offline", count: offlineBucket.length } }, ...offlineBucket);
    }

    return {
        type: "GUILD_MEMBER_LIST_UPDATE",
        guildId,
        id: memberListId,
        ops: [
            {
                op: "SYNC",
                items: listItems,
                range: [0, Math.max(99, listItems.length)]
            }
        ],
        groups,
        memberCount: members.length,
        onlineCount: members.length - offlineBucket.length
    };
}

/**
 * Queries Discord's Metro stores and dispatches `GUILD_MEMBER_LIST_UPDATE` for the
 * currently selected guild channel on Android.
 */
export function updateGuildMembersListImmediate(explicitGuildId?: string, explicitChannelId?: string): boolean {
    if (!botStorage.botClientMode || !botStorage.showMemberList) return false;

    try {
        const SelectedGuildStore = findByStoreName("SelectedGuildStore");
        const SelectedChannelStore = findByStoreName("SelectedChannelStore");
        const ChannelStore = findByStoreName("ChannelStore");
        const GuildStore = findByStoreName("GuildStore");
        const GuildMemberStore = findByStoreName("GuildMemberStore");
        const GuildRoleStore = findByStoreName("GuildRoleStore");
        const PresenceStore = findByStoreName("PresenceStore");
        const UserStore = findByStoreName("UserStore");

        const guildId = explicitGuildId || SelectedGuildStore?.getGuildId?.();
        const channelId = explicitChannelId || SelectedChannelStore?.getChannelId?.(guildId);
        if (!guildId || !channelId) return false;

        const channel = ChannelStore?.getChannel?.(channelId);
        const guild = GuildStore?.getGuild?.(guildId);
        if (!channel || !guild) return false;

        const rawMembers =
            GuildMemberStore?.getMembers?.(guildId) ||
            Object.values(GuildMemberStore?.getMemberIds?.(guildId) || {});
        if (!Array.isArray(rawMembers) || rawMembers.length === 0) return false;

        const roles =
            GuildRoleStore?.getRolesSnapshot?.(guildId) ||
            GuildRoleStore?.getRoles?.(guildId) ||
            guild.roles ||
            {};

        const presences: Record<string, string> = {};
        const users: Record<string, any> = {};

        for (const m of rawMembers) {
            const uid = m.userId || m.user?.id;
            if (!uid) continue;
            presences[uid] = PresenceStore?.getStatus?.(uid) || "offline";
            const u = UserStore?.getUser?.(uid);
            if (u) users[uid] = u;
        }

        const payload = buildMemberListPayload({
            guildId,
            channel,
            guildOwnerId: guild.ownerId || guild.owner_id,
            roles,
            members: rawMembers,
            presences,
            users
        });

        const FluxDispatcher = findByProps("_interceptors", "dispatch");
        FluxDispatcher?.dispatch?.(payload);
        return true;
    } catch (err) {
        logger.error("[BotClient] updateGuildMembersListImmediate failed:", err);
        return false;
    }
}

export const updateGuildMembersList = throttle(
    (guildId?: string, channelId?: string) => {
        updateGuildMembersListImmediate(guildId, channelId);
    },
    2000
);
