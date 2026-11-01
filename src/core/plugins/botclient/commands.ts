import { registerCommand } from "@lib/api/commands";
import {
    ApplicationCommandInputType,
    ApplicationCommandOptionType,
    ApplicationCommandType,
    BunnyApplicationCommand
} from "@lib/api/commands/types";
import { messageUtil } from "@metro/common";
import { findByStoreName } from "@metro/wrappers";
import { getActiveBotToken, getBotInfo, rawDiscordBotFetch } from "./apiInterceptor";
import { IntentsBitField, SnowflakeUtil } from "./bitfield";
import { DBC_VERSION } from "./constants";
import { loginWithBotToken, switchBotShard } from "./gatewayPatches";
import { botStorage } from "./storage";

export function registerBotClientCommands(): () => void {
    const unregisterFns: Array<() => void> = [];

    const commands: BunnyApplicationCommand[] = [
        // 1. /ping
        {
            name: "ping",
            description: "Check Discord Gateway WebSocket & REST API latency (BotClient)",
            type: ApplicationCommandType.CHAT,
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "ephemeral",
                    description: "Show result only to you (default: true)",
                    type: ApplicationCommandOptionType.BOOLEAN,
                    required: false
                }
            ],
            execute: async (args, ctx) => {
                const ephemeral =
                    args.find((a: any) => a.name === "ephemeral")?.value ?? true;
                const GatewayConnectionStore = findByStoreName("GatewayConnectionStore");
                const socket = GatewayConnectionStore?.getSocket?.();
                const wsPing =
                    socket?.pings?.length > 0
                        ? Math.round(socket.pings[socket.pings.length - 1])
                        : null;

                const start = Date.now();
                await rawDiscordBotFetch("/users/@me").catch(() => null);
                const restPing = Date.now() - start;

                const text =
                    `🏓 **Pong! (Revenge BotClient ${DBC_VERSION})**\n` +
                    `- **Gateway Shard**: \`${botStorage.currentShard} / ${Math.max(1, botStorage.allShards) - 1}\`\n` +
                    `- **WebSocket Ping**: \`${wsPing !== null ? `${wsPing}ms` : "N/A"}\`\n` +
                    `- **REST API Latency**: \`${restPing}ms\``;

                if (ephemeral) {
                    messageUtil.sendBotMessage(ctx.channel.id, text);
                    return;
                }
                return { content: text };
            }
        },

        // 2. /botinfo
        {
            name: "botinfo",
            description: "Inspect current Bot Application ID, Privileged Intents, and Sharding state",
            type: ApplicationCommandType.CHAT,
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [],
            execute: async (_args, ctx) => {
                const token = getActiveBotToken();
                if (!token) {
                    messageUtil.sendBotMessage(
                        ctx.channel.id,
                        "⚠️ No active Bot Token found in BotClient storage."
                    );
                    return;
                }

                const info = await getBotInfo(token);
                if (!info.success) {
                    messageUtil.sendBotMessage(
                        ctx.channel.id,
                        `❌ Failed to fetch bot info: ${info.message}`
                    );
                    return;
                }

                const intentNames = new IntentsBitField(info.intents).toArray().join(", ");
                const report =
                    `🤖 **DiscordBotClient Android Status**\n` +
                    `- **Bot Account**: \`${info.username}#${info.discriminator}\` (\`${info.id}\`)\n` +
                    `- **Guild Count**: \`${info.guildCount}\` across \`${info.allShards}\` shard(s)\n` +
                    `- **Current Shard**: \`${botStorage.currentShard}\`\n` +
                    `- **Privileged Intents**:\n` +
                    `  - \`GUILD_PRESENCES\`: ${info.hasPresence ? "✅" : "❌"}\n` +
                    `  - \`GUILD_MEMBERS\`: ${info.hasGuildMembers ? "✅" : "❌"}\n` +
                    `  - \`MESSAGE_CONTENT\`: ${info.hasMessageContent ? "✅" : "❌"}\n` +
                    `- **Active Intents (${info.intents})**: \`${intentNames}\``;

                messageUtil.sendBotMessage(ctx.channel.id, report);
            }
        },

        // 3. /purge
        {
            name: "purge",
            description: "Bulk delete messages in the current channel (2 - 100)",
            type: ApplicationCommandType.CHAT,
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "count",
                    description: "Number of messages to delete (2 - 100)",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: true
                }
            ],
            execute: async (args, ctx) => {
                const rawCount = Number(args.find((a: any) => a.name === "count")?.value || 0);
                const count = Math.min(100, Math.max(2, rawCount));
                const channelId = ctx.channel.id;

                const fetchRes = await rawDiscordBotFetch(
                    `/channels/${channelId}/messages?limit=${count}`
                );
                if (!fetchRes.ok) {
                    const err = await fetchRes.json().catch(() => ({}));
                    messageUtil.sendBotMessage(
                        ctx.channel.id,
                        `❌ Failed to fetch messages: ${err.message || fetchRes.status}`
                    );
                    return;
                }

                const messages = await fetchRes.json();
                if (!Array.isArray(messages) || messages.length === 0) {
                    messageUtil.sendBotMessage(ctx.channel.id, "ℹ️ No messages found to purge.");
                    return;
                }

                const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
                const bulkIds = messages
                    .filter((m: any) => SnowflakeUtil.timestampFrom(m.id) > fourteenDaysAgo)
                    .map((m: any) => m.id);

                if (bulkIds.length >= 2) {
                    const bulkRes = await rawDiscordBotFetch(
                        `/channels/${channelId}/messages/bulk-delete`,
                        undefined,
                        {
                            method: "POST",
                            body: JSON.stringify({ messages: bulkIds })
                        }
                    );
                    if (bulkRes.ok) {
                        messageUtil.sendBotMessage(
                            channelId,
                            `🗑️ Successfully bulk-deleted **${bulkIds.length}** messages.`
                        );
                        return;
                    }
                }

                // Fallback for DM or < 2 bulkable messages: delete own messages individually
                let deleted = 0;
                for (const m of messages) {
                    const delRes = await rawDiscordBotFetch(
                        `/channels/${channelId}/messages/${m.id}`,
                        undefined,
                        { method: "DELETE" }
                    );
                    if (delRes.ok) deleted++;
                }
                messageUtil.sendBotMessage(
                    channelId,
                    `🗑️ Deleted **${deleted}** messages individually.`
                );
            }
        },

        // 4. /switch
        {
            name: "switch",
            description: "Switch Gateway Shard ID or switch to another saved Bot account",
            type: ApplicationCommandType.CHAT,
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "shard",
                    description: "Target Gateway Shard ID (0 to allShards - 1)",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: false
                },
                {
                    name: "bot_id",
                    description: "Saved Bot User ID to switch to",
                    type: ApplicationCommandOptionType.STRING,
                    required: false
                }
            ],
            execute: async (args, ctx) => {
                const shardOpt = args.find((a: any) => a.name === "shard")?.value;
                const botIdOpt = args.find((a: any) => a.name === "bot_id")?.value;

                if (botIdOpt) {
                    const saved = botStorage.bots?.[String(botIdOpt)];
                    if (!saved) {
                        messageUtil.sendBotMessage(
                            ctx.channel.id,
                            `❌ Bot ID \`${botIdOpt}\` not found in saved Bot accounts.`
                        );
                        return;
                    }
                    const res = await loginWithBotToken(saved.token, saved.currentShard);
                    messageUtil.sendBotMessage(
                        ctx.channel.id,
                        res.success ? `✅ ${res.message}` : `❌ ${res.message}`
                    );
                    return;
                }

                if (shardOpt !== undefined) {
                    const res = await switchBotShard(Number(shardOpt));
                    messageUtil.sendBotMessage(
                        ctx.channel.id,
                        res.success ? `✅ ${res.message}` : `❌ ${res.message}`
                    );
                    return;
                }

                messageUtil.sendBotMessage(
                    ctx.channel.id,
                    "ℹ️ Please provide either `shard` or `bot_id`."
                );
            }
        },

        // 5. /embed
        {
            name: "embed",
            description: "Send a rich Discord Embed message from your Bot account",
            type: ApplicationCommandType.CHAT,
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "description",
                    description: "Embed description text",
                    type: ApplicationCommandOptionType.STRING,
                    required: true
                },
                {
                    name: "title",
                    description: "Embed title",
                    type: ApplicationCommandOptionType.STRING,
                    required: false
                },
                {
                    name: "color",
                    description: "Hex color (e.g. #5865F2)",
                    type: ApplicationCommandOptionType.STRING,
                    required: false
                },
                {
                    name: "image",
                    description: "Image URL",
                    type: ApplicationCommandOptionType.STRING,
                    required: false
                },
                {
                    name: "footer",
                    description: "Footer text",
                    type: ApplicationCommandOptionType.STRING,
                    required: false
                }
            ],
            execute: async (args, ctx) => {
                const getOpt = (name: string) =>
                    args.find((a: any) => a.name === name)?.value;

                const title = getOpt("title");
                const description = getOpt("description");
                const colorStr = String(getOpt("color") || "#5865F2").replace("#", "");
                const color = parseInt(colorStr, 16) || 0x5865f2;
                const image = getOpt("image");
                const footer = getOpt("footer");

                const embed: Record<string, any> = {
                    description,
                    color,
                    timestamp: new Date().toISOString()
                };
                if (title) embed.title = title;
                if (image) embed.image = { url: image };
                if (footer) embed.footer = { text: footer };

                const res = await rawDiscordBotFetch(
                    `/channels/${ctx.channel.id}/messages`,
                    undefined,
                    {
                        method: "POST",
                        body: JSON.stringify({ embeds: [embed] })
                    }
                );

                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    messageUtil.sendBotMessage(
                        ctx.channel.id,
                        `❌ Failed to send embed: ${err.message || res.status}`
                    );
                }
            }
        }
    ];

    for (const cmd of commands) {
        try {
            unregisterFns.push(registerCommand(cmd));
        } catch {
            // Ignore if builtInCommands aren't initialized yet
        }
    }

    return () => {
        for (const unreg of unregisterFns) {
            try {
                unreg();
            } catch {
                // Ignore
            }
        }
    };
}
