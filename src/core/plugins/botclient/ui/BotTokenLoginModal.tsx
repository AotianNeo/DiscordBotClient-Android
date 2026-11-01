import { before } from "@lib/api/patcher";
import { logger } from "@lib/utils/logger";
import { clipboard, React, ReactNative } from "@metro/common";
import { findByProps } from "@metro/wrappers";
import { ErrorBoundary } from "@ui/components";
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from "react-native";
import { DBC_VERSION } from "../constants";
import {
    isBotSessionAuthenticated,
    loginWithBotToken,
    subscribeBotAuthOverlay
} from "../gatewayPatches";
import {
    botStorage,
    cleanBotToken,
    removeBotAccount,
    SavedBotAccount
} from "../storage";

export function BotTokenLoginOverlay() {
    const styles = getStyles();
    const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
    const [authenticated, setAuthenticated] = React.useState<boolean>(() =>
        isBotSessionAuthenticated()
    );
    const [minimized, setMinimized] = React.useState<boolean>(false);
    const [tokenInput, setTokenInput] = React.useState<string>("");
    const [shardInput, setShardInput] = React.useState<string>(
        String(botStorage.currentShard || 0)
    );
    const [showToken, setShowToken] = React.useState<boolean>(false);
    const [isLoading, setIsLoading] = React.useState<boolean>(false);
    const [errorMsg, setErrorMsg] = React.useState<string>("");

    React.useEffect(() => {
        const syncAuthState = () => {
            const nextAuth = isBotSessionAuthenticated();
            setAuthenticated(prev => {
                if (prev && !nextAuth) {
                    setMinimized(false);
                    setErrorMsg("");
                }
                return nextAuth;
            });
            forceUpdate();
        };

        const unsub = subscribeBotAuthOverlay(syncAuthState);
        const t1 = setTimeout(syncAuthState, 350);
        const t2 = setTimeout(syncAuthState, 1200);
        const interval = setInterval(syncAuthState, 2500);

        return () => {
            unsub();
            clearTimeout(t1);
            clearTimeout(t2);
            clearInterval(interval);
        };
    }, []);

    if (authenticated || !botStorage.botClientMode) {
        return null;
    }

    if (minimized) {
        return (
            <View style={styles.floatingContainer} pointerEvents="box-none">
                <TouchableOpacity
                    accessibilityLabel="Open Bot Login"
                    activeOpacity={0.85}
                    style={styles.floatingPill}
                    onPress={() => setMinimized(false)}
                >
                    <Text style={styles.floatingPillText}>Bot Token Login</Text>
                </TouchableOpacity>
            </View>
        );
    }

    const savedBots: SavedBotAccount[] = Object.values(botStorage.bots || {});

    const handlePaste = async () => {
        try {
            const clip = await clipboard?.getString?.();
            if (clip && typeof clip === "string") {
                setTokenInput(clip.trim());
                setErrorMsg("");
            }
        } catch {}
    };

    const handleSubmit = async (overrideToken?: string, overrideShard?: number) => {
        const candidate = cleanBotToken(overrideToken ?? tokenInput);
        if (!candidate) {
            setErrorMsg("Please enter a valid Discord Bot Token.");
            return;
        }
        setErrorMsg("");
        setIsLoading(true);
        try {
            const targetShard =
                overrideShard !== undefined
                    ? overrideShard
                    : Math.max(0, parseInt(shardInput, 10) || 0);
            const res = await loginWithBotToken(candidate, targetShard);
            if (!res.success) {
                setErrorMsg(res.message || "Invalid Bot Token.");
                return;
            }
            setTokenInput("");
            setAuthenticated(true);
        } catch (err: any) {
            setErrorMsg(err?.message || "Failed to log in with Bot Token.");
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <View style={styles.backdrop}>
            <KeyboardAvoidingView
                behavior={Platform.OS === "ios" ? "padding" : undefined}
                style={styles.keyboardView}
            >
                <ScrollView
                    contentContainerStyle={styles.scrollContent}
                    keyboardShouldPersistTaps="handled"
                >
                    <View style={styles.card}>
                        <View style={styles.headerRow}>
                            <View style={styles.badge}>
                                <Text style={styles.badgeText}>BOT</Text>
                            </View>
                            <View style={styles.headerTextCol}>
                                <Text style={styles.title}>DiscordBotClient</Text>
                                <Text style={styles.subtitle}>
                                    Android Standalone • v{DBC_VERSION}
                                </Text>
                            </View>
                        </View>

                        <Text style={styles.description}>
                            Sign in directly to the full Discord Android client using your Bot
                            Token.
                        </Text>

                        {errorMsg ? (
                            <View style={styles.errorBox}>
                                <Text style={styles.errorText}>{errorMsg}</Text>
                            </View>
                        ) : null}

                        <View style={styles.fieldGroup}>
                            <View style={styles.labelRow}>
                                <Text style={styles.label}>BOT TOKEN</Text>
                                <View style={styles.inlineActions}>
                                    <TouchableOpacity
                                        accessibilityLabel="Paste Token"
                                        onPress={handlePaste}
                                        style={styles.smallLinkBtn}
                                    >
                                        <Text style={styles.smallLinkText}>Paste</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                        accessibilityLabel="Toggle Show Token"
                                        onPress={() => setShowToken(v => !v)}
                                        style={styles.smallLinkBtn}
                                    >
                                        <Text style={styles.smallLinkText}>
                                            {showToken ? "Hide" : "Show"}
                                        </Text>
                                    </TouchableOpacity>
                                    {tokenInput.length > 0 ? (
                                        <TouchableOpacity
                                            accessibilityLabel="Clear Token"
                                            onPress={() => {
                                                setTokenInput("");
                                                setErrorMsg("");
                                            }}
                                            style={styles.smallLinkBtn}
                                        >
                                            <Text style={styles.smallLinkText}>Clear</Text>
                                        </TouchableOpacity>
                                    ) : null}
                                </View>
                            </View>
                            <TextInput
                                accessibilityLabel="Bot Token Input"
                                style={styles.input}
                                placeholder="Enter your bot token (MT...)"
                                placeholderTextColor="#80848E"
                                value={tokenInput}
                                onChangeText={t => {
                                    setTokenInput(t);
                                    if (errorMsg) setErrorMsg("");
                                }}
                                autoCapitalize="none"
                                autoCorrect={false}
                                secureTextEntry={!showToken}
                                editable={!isLoading}
                            />
                        </View>

                        <View style={styles.fieldGroup}>
                            <Text style={styles.label}>INITIAL SHARD ID (OPTIONAL)</Text>
                            <TextInput
                                accessibilityLabel="Shard ID Input"
                                style={styles.input}
                                placeholder="0"
                                placeholderTextColor="#80848E"
                                value={shardInput}
                                onChangeText={setShardInput}
                                keyboardType="numeric"
                                editable={!isLoading}
                            />
                        </View>

                        <TouchableOpacity
                            accessibilityLabel="Login with Bot Token"
                            activeOpacity={0.85}
                            disabled={isLoading}
                            style={[styles.loginBtn, isLoading && styles.loginBtnDisabled]}
                            onPress={() => handleSubmit()}
                        >
                            {isLoading ? (
                                <ActivityIndicator color="#FFFFFF" size="small" />
                            ) : (
                                <Text style={styles.loginBtnText}>Login with Bot Token</Text>
                            )}
                        </TouchableOpacity>

                        {savedBots.length > 0 ? (
                            <View style={styles.savedSection}>
                                <Text style={styles.label}>
                                    SAVED BOT ACCOUNTS ({savedBots.length})
                                </Text>
                                {savedBots.map(bot => (
                                    <View key={bot.id} style={styles.savedRow}>
                                        <TouchableOpacity
                                            accessibilityLabel={`Login Saved Bot ${bot.username}`}
                                            disabled={isLoading}
                                            style={styles.savedInfo}
                                            onPress={() =>
                                                handleSubmit(bot.token, bot.currentShard || 0)
                                            }
                                        >
                                            <Text style={styles.savedName} numberOfLines={1}>
                                                {bot.username}#{bot.discriminator}
                                            </Text>
                                            <Text style={styles.savedMeta} numberOfLines={1}>
                                                ID: {bot.id} • {bot.guildCount} servers • Shard{" "}
                                                {bot.currentShard}/{bot.allShards}
                                            </Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity
                                            accessibilityLabel={`Remove Saved Bot ${bot.username}`}
                                            disabled={isLoading}
                                            style={styles.removeBtn}
                                            onPress={() => {
                                                removeBotAccount(bot.id);
                                                forceUpdate();
                                            }}
                                        >
                                            <Text style={styles.removeBtnText}>Remove</Text>
                                        </TouchableOpacity>
                                    </View>
                                ))}
                            </View>
                        ) : null}

                        <TouchableOpacity
                            accessibilityLabel="Minimize Bot Login"
                            style={styles.secondaryBtn}
                            disabled={isLoading}
                            onPress={() => setMinimized(true)}
                        >
                            <Text style={styles.secondaryBtnText}>
                                Minimize to Standard Welcome Screen
                            </Text>
                        </TouchableOpacity>
                    </View>
                </ScrollView>
            </KeyboardAvoidingView>
        </View>
    );
}

export function patchRootBotLoginUI(): () => void {
    const unpatches: Array<() => void> = [];
    try {
        const AppRegistry =
            findByProps("registerComponent", "runApplication", "setWrapperComponentProvider") ??
            findByProps("registerComponent", "runApplication") ??
            ReactNative?.AppRegistry ??
            (globalThis as any).RN$AppRegistry;

        if (AppRegistry && typeof AppRegistry.setWrapperComponentProvider === "function") {
            function DiscordBotClientWrapper(props: any) {
                const styles = getStyles();
                return (
                    <View style={styles.rootFlex}>
                        {props?.children}
                        <ErrorBoundary>
                            <BotTokenLoginOverlay />
                        </ErrorBoundary>
                    </View>
                );
            }

            AppRegistry.setWrapperComponentProvider((appParams: any) => {
                // Do not wrap LogBox / Share auxiliary surfaces if appParams indicates non-main surface
                return DiscordBotClientWrapper;
            });

            unpatches.push(() => {
                try {
                    AppRegistry.setWrapperComponentProvider(null);
                } catch {}
            });

            console.log(
                "[BotClient] Installed AppRegistry.setWrapperComponentProvider! appKeys =",
                AppRegistry.getAppKeys?.()
            );
        } else if (AppRegistry && typeof AppRegistry.registerComponent === "function") {
            const wrapComponentProvider = (
                appKey: string,
                componentProvider: () => React.ComponentType<any>
            ) => {
                if (appKey !== "Discord" && appKey !== "main") {
                    return componentProvider;
                }
                if ((componentProvider as any).__dbcRootWrapped) {
                    return componentProvider;
                }
                const wrappedProvider = () => {
                    const OrigRoot = componentProvider();
                    function DiscordBotClientRoot(props: any) {
                        const styles = getStyles();
                        return (
                            <View style={styles.rootFlex}>
                                <OrigRoot {...props} />
                                <ErrorBoundary>
                                    <BotTokenLoginOverlay />
                                </ErrorBoundary>
                            </View>
                        );
                    }
                    return DiscordBotClientRoot;
                };
                (wrappedProvider as any).__dbcRootWrapped = true;
                return wrappedProvider;
            };

            unpatches.push(
                before("registerComponent", AppRegistry, (args: any[]) => {
                    if (typeof args[0] === "string" && typeof args[1] === "function") {
                        args[1] = wrapComponentProvider(args[0], args[1]);
                    }
                })
            );
        } else {
            console.warn("[BotClient] AppRegistry not found during patchRootBotLoginUI");
        }
    } catch (err) {
        console.error("[BotClient] Failed to hook AppRegistry:", err);
        logger.error("[BotClient] Failed to hook AppRegistry:", err);
    }

    return () => {
        for (const u of unpatches) {
            try {
                u();
            } catch {}
        }
    };
}

let _cachedStyles: any = null;
function getStyles() {
    if (_cachedStyles) return _cachedStyles;
    _cachedStyles = StyleSheet.create({
    rootFlex: {
        flex: 1
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: "rgba(17, 18, 20, 0.96)",
        zIndex: 9999,
        elevation: 9999
    },
    keyboardView: {
        flex: 1
    },
    scrollContent: {
        flexGrow: 1,
        justifyContent: "center",
        paddingHorizontal: 20,
        paddingVertical: 36
    },
    card: {
        backgroundColor: "#2B2D31",
        borderRadius: 16,
        padding: 22,
        borderWidth: 1,
        borderColor: "#3F4147"
    },
    headerRow: {
        flexDirection: "row",
        alignItems: "center",
        marginBottom: 10
    },
    badge: {
        backgroundColor: "#5865F2",
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 6,
        marginRight: 12
    },
    badgeText: {
        color: "#FFFFFF",
        fontWeight: "800",
        fontSize: 13,
        letterSpacing: 0.6
    },
    headerTextCol: {
        flex: 1
    },
    title: {
        color: "#F2F3F5",
        fontSize: 22,
        fontWeight: "800"
    },
    subtitle: {
        color: "#949BA4",
        fontSize: 12,
        marginTop: 2
    },
    description: {
        color: "#B5BAC1",
        fontSize: 14,
        lineHeight: 20,
        marginBottom: 18
    },
    errorBox: {
        backgroundColor: "rgba(218, 55, 60, 0.18)",
        borderColor: "#DA373C",
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        marginBottom: 14
    },
    errorText: {
        color: "#FA777C",
        fontSize: 13,
        fontWeight: "600"
    },
    fieldGroup: {
        marginBottom: 16
    },
    labelRow: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 6
    },
    label: {
        color: "#B5BAC1",
        fontSize: 12,
        fontWeight: "700",
        letterSpacing: 0.4,
        marginBottom: 6
    },
    inlineActions: {
        flexDirection: "row",
        alignItems: "center"
    },
    smallLinkBtn: {
        marginLeft: 12,
        paddingVertical: 2
    },
    smallLinkText: {
        color: "#00A8FC",
        fontSize: 12,
        fontWeight: "700"
    },
    input: {
        backgroundColor: "#1E1F22",
        color: "#F2F3F5",
        borderRadius: 8,
        paddingHorizontal: 14,
        paddingVertical: 12,
        fontSize: 15,
        borderWidth: 1,
        borderColor: "#383A40"
    },
    loginBtn: {
        backgroundColor: "#5865F2",
        borderRadius: 8,
        paddingVertical: 14,
        alignItems: "center",
        justifyContent: "center",
        marginTop: 4
    },
    loginBtnDisabled: {
        opacity: 0.65
    },
    loginBtnText: {
        color: "#FFFFFF",
        fontSize: 16,
        fontWeight: "700"
    },
    savedSection: {
        marginTop: 20,
        paddingTop: 16,
        borderTopWidth: 1,
        borderTopColor: "#3F4147"
    },
    savedRow: {
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: "#1E1F22",
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        marginTop: 8
    },
    savedInfo: {
        flex: 1,
        marginRight: 8
    },
    savedName: {
        color: "#F2F3F5",
        fontSize: 14,
        fontWeight: "700"
    },
    savedMeta: {
        color: "#949BA4",
        fontSize: 12,
        marginTop: 2
    },
    removeBtn: {
        backgroundColor: "#DA373C",
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 6
    },
    removeBtnText: {
        color: "#FFFFFF",
        fontSize: 12,
        fontWeight: "700"
    },
    secondaryBtn: {
        marginTop: 14,
        paddingVertical: 10,
        alignItems: "center"
    },
    secondaryBtnText: {
        color: "#949BA4",
        fontSize: 13,
        fontWeight: "600"
    },
    floatingContainer: {
        position: "absolute",
        top: 52,
        right: 16,
        zIndex: 9999,
        elevation: 9999
    },
    floatingPill: {
        backgroundColor: "#5865F2",
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: "#7983F5"
    },
    floatingPillText: {
        color: "#FFFFFF",
        fontSize: 13,
        fontWeight: "700"
    }
    });
    return _cachedStyles;
}
