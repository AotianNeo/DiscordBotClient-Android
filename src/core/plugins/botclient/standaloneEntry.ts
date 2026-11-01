import { patchHttpInterceptors } from "./apiInterceptor";
import { registerBotClientCommands } from "./commands";
import { DBC_VERSION } from "./constants";
import { patchGatewayAndStores } from "./gatewayPatches";
import { initBotClientStorage } from "./storage";
import BotClientSettings from "./ui/BotClientSettings";

let unpatches: Array<() => void> = [];

const plugin = (typeof definePlugin === "function" ? definePlugin : (x: any) => x)({
    manifest: {
        id: "revenge.botclient",
        name: "DiscordBotClient",
        version: DBC_VERSION,
        type: "plugin",
        spec: 3,
        main: "index.js",
        description:
            "Full DiscordBotClient for Android (Revenge): Bot Token authentication, HTTP API Bot route proxy, Gateway Intents & Sharding, Opcode 14 member list calculation, DM persistence, and Bot slash commands.",
        authors: [
            { name: "aiko-chan-ai" },
            { name: "Revenge Team" },
            { name: "XiaoHan" }
        ]
    },
    start() {
        initBotClientStorage();
        unpatches = [
            patchHttpInterceptors(),
            patchGatewayAndStores(),
            registerBotClientCommands()
        ];
    },
    stop() {
        for (const unpatch of unpatches) {
            try {
                unpatch();
            } catch {
                // Ignore
            }
        }
        unpatches = [];
    },
    SettingsComponent: BotClientSettings
});

export default plugin;
