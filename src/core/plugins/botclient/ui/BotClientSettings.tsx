import { findAssetId } from "@lib/api/assets";
import { showToast } from "@lib/ui/toasts";
import { FluxDispatcher } from "@metro/common";
import {
    Button,
    LegacyFormText,
    Stack,
    TableRow,
    TableRowGroup,
    TableSwitchRow,
    TextInput
} from "@metro/common/components";
import { ErrorBoundary } from "@ui/components";
import { ScrollView, View } from "react-native";
import { rawDiscordBotFetch } from "../apiInterceptor";
import { computeBotIntents } from "../bitfield";
import { DBC_VERSION } from "../constants";
import { loginWithBotToken, logoutBotAccount, switchBotShard } from "../gatewayPatches";
import { updateGuildMembersListImmediate } from "../memberList";
import {
    botStorage,
    removeBotAccount,
    SavedBotAccount,
    savePrivateChannel
} from "../storage";

export default function BotClientSettings() {
    const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
    const [tokenInput, setTokenInput] = React.useState("");
    const [shardInput, setShardInput] = React.useState(String(botStorage.currentShard || 0));
    const [guildsPerShardInput, setGuildsPerShardInput] = React.useState(
        String(botStorage.guildsPerShard || 1000)
    );
    const [dmUserIdInput, setDmUserIdInput] = React.useState("");
    const [isLoggingIn, setIsLoggingIn] = React.useState(false);

    const savedBots: SavedBotAccount[] = Object.values(botStorage.bots || {});
    const currentBot = botStorage.currentBotId
        ? botStorage.bots?.[botStorage.currentBotId]
        : null;

    const intentDetails = currentBot
        ? computeBotIntents(currentBot.applicationFlags || 0)
        : null;

    const handleBotLogin = async () => {
        if (!tokenInput.trim()) {
            showToast("Please paste a valid Bot Token first.", findAssetId("WarningIcon"));
            return;
        }
        setIsLoggingIn(true);
        try {
            const targetShard = parseInt(shardInput, 10) || 0;
            const res = await loginWithBotToken(tokenInput, targetShard);
            showToast(
                res.message,
                findAssetId(res.success ? "CheckmarkIcon" : "WarningIcon")
            );
            if (res.success) {
                setTokenInput("");
            }
            forceUpdate();
        } finally {
            setIsLoggingIn(false);
        }
    };

    const handleOpenDirectMessage = async () => {
        const recipientId = dmUserIdInput.trim();
        if (!recipientId) {
            showToast("Enter a target User Snowflake ID.", findAssetId("WarningIcon"));
            return;
        }
        const res = await rawDiscordBotFetch("/users/@me/channels", undefined, {
            method: "POST",
            body: JSON.stringify({ recipient_id: recipientId })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            showToast(
                `Failed to open DM: ${err.message || res.status}`,
                findAssetId("WarningIcon")
            );
            return;
        }
        const channelObj = await res.json();
        if (channelObj?.id) {
            savePrivateChannel(botStorage.currentBotId, channelObj.id, channelObj);
            FluxDispatcher?.dispatch?.({
                type: "CHANNEL_CREATE",
                channel: channelObj
            });
            showToast(
                `Opened DM with ${channelObj.recipients?.[0]?.username || recipientId}`,
                findAssetId("CheckmarkIcon")
            );
            setDmUserIdInput("");
            forceUpdate();
        }
    };

    return (
        <ErrorBoundary>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 48 }}>
                <Stack style={{ paddingVertical: 20, paddingHorizontal: 12 }} spacing={20}>
                    <TableRowGroup title={`DiscordBotClient Android (${DBC_VERSION})`}>
                        <TableSwitchRow
                            label="Enable Bot Client Mode"
                            subLabel="Intercepts Discord HTTP & Gateway protocols for Bot Tokens (Authorization: Bot, Intents, Sharding, Opcode 14 bypass, READY patch)"
                            icon={<TableRow.Icon source={findAssetId("RobotIcon") || findAssetId("WrenchIcon")} />}
                            value={Boolean(botStorage.botClientMode)}
                            onValueChange={(v: boolean) => {
                                botStorage.botClientMode = v;
                                forceUpdate();
                            }}
                        />
                        {currentBot && (
                            <TableRow
                                label={`Active Bot: ${currentBot.username}#${currentBot.discriminator}`}
                                subLabel={`ID: ${currentBot.id} • Shard ${botStorage.currentShard}/${Math.max(1, botStorage.allShards) - 1} • ${currentBot.guildCount} Guilds`}
                                icon={<TableRow.Icon source={findAssetId("CheckmarkIcon")} />}
                                trailing={
                                    <Button
                                        size="sm"
                                        variant="destructive"
                                        text="Log Out"
                                        onPress={() => {
                                            logoutBotAccount();
                                            showToast(
                                                "Logged out of Bot session",
                                                findAssetId("CheckmarkIcon")
                                            );
                                            forceUpdate();
                                        }}
                                    />
                                }
                            />
                        )}
                    </TableRowGroup>

                    <TableRowGroup title="Bot Token Login">
                        <View style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 12 }}>
                            <TextInput
                                label="Discord Bot Token"
                                placeholder="Paste Bot Token (with or without 'Bot ' prefix)"
                                size="md"
                                secureTextEntry={true}
                                defaultValue={tokenInput}
                                onChange={(v: string) => setTokenInput(v)}
                            />
                            <TextInput
                                label="Initial Shard ID"
                                placeholder="0"
                                size="md"
                                defaultValue={shardInput}
                                onChange={(v: string) => setShardInput(v)}
                            />
                            <Button
                                size="md"
                                variant="primary"
                                loading={isLoggingIn}
                                disabled={isLoggingIn}
                                text="Login with Bot Token"
                                icon={findAssetId("KeyIcon") || findAssetId("LinkIcon")}
                                onPress={handleBotLogin}
                            />
                        </View>
                    </TableRowGroup>

                    {savedBots.length > 0 && (
                        <TableRowGroup title={`Saved Bot Accounts (${savedBots.length})`}>
                            {savedBots.map(bot => {
                                const isCurrent = bot.id === botStorage.currentBotId;
                                return (
                                    <TableRow
                                        key={bot.id}
                                        label={`${bot.username}#${bot.discriminator}${isCurrent ? " (Active)" : ""}`}
                                        subLabel={`ID: ${bot.id} • ${bot.guildCount} guilds • Shard ${bot.currentShard}/${bot.allShards}`}
                                        icon={
                                            <TableRow.Icon
                                                source={findAssetId(
                                                    isCurrent ? "CheckmarkIcon" : "UserIcon"
                                                )}
                                            />
                                        }
                                        onPress={async () => {
                                            const res = await loginWithBotToken(
                                                bot.token,
                                                bot.currentShard
                                            );
                                            showToast(
                                                res.message,
                                                findAssetId(
                                                    res.success ? "CheckmarkIcon" : "WarningIcon"
                                                )
                                            );
                                            forceUpdate();
                                        }}
                                        trailing={
                                            <Button
                                                size="sm"
                                                variant="destructive"
                                                text="Remove"
                                                onPress={() => {
                                                    removeBotAccount(bot.id);
                                                    showToast(
                                                        `Removed ${bot.username}`,
                                                        findAssetId("TrashIcon")
                                                    );
                                                    forceUpdate();
                                                }}
                                            />
                                        }
                                    />
                                );
                            })}
                        </TableRowGroup>
                    )}

                    <TableRowGroup title="Gateway Sharding & Intents">
                        <View style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 12 }}>
                            <TextInput
                                label={`Active Shard (0 to ${Math.max(1, botStorage.allShards) - 1})`}
                                placeholder="0"
                                size="md"
                                defaultValue={String(botStorage.currentShard)}
                                onChange={(v: string) => setShardInput(v)}
                            />
                            <Button
                                size="sm"
                                variant="secondary"
                                text={`Switch to Shard ${shardInput || 0}`}
                                onPress={async () => {
                                    const res = await switchBotShard(parseInt(shardInput, 10) || 0);
                                    showToast(
                                        res.message,
                                        findAssetId(res.success ? "CheckmarkIcon" : "WarningIcon")
                                    );
                                    forceUpdate();
                                }}
                            />
                            <TextInput
                                label="Guilds Per Shard (100 - 2500)"
                                placeholder="1000"
                                size="md"
                                defaultValue={guildsPerShardInput}
                                onChange={(v: string) => {
                                    setGuildsPerShardInput(v);
                                    const parsed = parseInt(v, 10);
                                    if (!isNaN(parsed) && parsed >= 100 && parsed <= 2500) {
                                        botStorage.guildsPerShard = parsed;
                                    }
                                }}
                            />
                        </View>
                        {intentDetails && (
                            <>
                                <TableRow
                                    label="GUILD_PRESENCES Intent"
                                    subLabel={
                                        intentDetails.hasPresence
                                            ? "Enabled in Developer Portal"
                                            : "Disabled in Developer Portal"
                                    }
                                    trailing={
                                        <LegacyFormText>
                                            {intentDetails.hasPresence ? "✅" : "❌"}
                                        </LegacyFormText>
                                    }
                                />
                                <TableRow
                                    label="GUILD_MEMBERS Intent"
                                    subLabel={
                                        intentDetails.hasGuildMembers
                                            ? "Enabled in Developer Portal"
                                            : "Disabled in Developer Portal"
                                    }
                                    trailing={
                                        <LegacyFormText>
                                            {intentDetails.hasGuildMembers ? "✅" : "❌"}
                                        </LegacyFormText>
                                    }
                                />
                                <TableRow
                                    label="MESSAGE_CONTENT Intent"
                                    subLabel={
                                        intentDetails.hasMessageContent
                                            ? "Enabled in Developer Portal"
                                            : "Disabled in Developer Portal"
                                    }
                                    trailing={
                                        <LegacyFormText>
                                            {intentDetails.hasMessageContent ? "✅" : "❌"}
                                        </LegacyFormText>
                                    }
                                />
                            </>
                        )}
                    </TableRowGroup>

                    <TableRowGroup title="Direct Messages & Member List">
                        <TableSwitchRow
                            label="Compute Guild Member List"
                            subLabel="Synthesizes GUILD_MEMBER_LIST_UPDATE locally without Opcode 14"
                            icon={<TableRow.Icon source={findAssetId("UsersIcon") || findAssetId("FriendsIcon")} />}
                            value={Boolean(botStorage.showMemberList)}
                            onValueChange={(v: boolean) => {
                                botStorage.showMemberList = v;
                                if (v) updateGuildMembersListImmediate();
                                forceUpdate();
                            }}
                        />
                        <TableSwitchRow
                            label="Persist Direct Messages"
                            subLabel="Saves opened DM channels across app restarts and injects them on READY"
                            icon={<TableRow.Icon source={findAssetId("ChatIcon") || findAssetId("MessageIcon")} />}
                            value={Boolean(botStorage.saveDirectMessage)}
                            onValueChange={(v: boolean) => {
                                botStorage.saveDirectMessage = v;
                                forceUpdate();
                            }}
                        />
                        <TableSwitchRow
                            label="Synthesize User & Bot Profiles"
                            subLabel="Intercepts /users/:id/profile to prevent HTTP 403 errors on Bot tokens"
                            icon={<TableRow.Icon source={findAssetId("UserIcon") || findAssetId("IdIcon")} />}
                            value={Boolean(botStorage.generateFakeProfile)}
                            onValueChange={(v: boolean) => {
                                botStorage.generateFakeProfile = v;
                                forceUpdate();
                            }}
                        />
                        <TableSwitchRow
                            label="Spoof Nitro & Application Emojis"
                            subLabel="Unlocks Nitro client features and maps /users/@me/emojis to /applications/:id/emojis"
                            icon={<TableRow.Icon source={findAssetId("SparklesIcon") || findAssetId("StarIcon")} />}
                            value={Boolean(botStorage.spoofNitro)}
                            onValueChange={(v: boolean) => {
                                botStorage.spoofNitro = v;
                                forceUpdate();
                            }}
                        />
                        <View style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 12 }}>
                            <TextInput
                                label="Open Direct Message by User ID"
                                placeholder="Enter User Snowflake ID (e.g. 123456789012345678)"
                                size="md"
                                defaultValue={dmUserIdInput}
                                onChange={(v: string) => setDmUserIdInput(v)}
                            />
                            <Button
                                size="sm"
                                variant="secondary"
                                text="Open DM Channel"
                                onPress={handleOpenDirectMessage}
                            />
                        </View>
                    </TableRowGroup>
                </Stack>
            </ScrollView>
        </ErrorBoundary>
    );
}
