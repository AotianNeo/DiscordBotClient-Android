import { defineCorePlugin } from "..";
import { patchHttpInterceptors } from "./apiInterceptor";
import { registerBotClientCommands } from "./commands";
import { DBC_VERSION } from "./constants";
import { patchGatewayAndStores } from "./gatewayPatches";
import { initBotClientStorage } from "./storage";
import BotClientSettings from "./ui/BotClientSettings";
import { patchRootBotLoginUI } from "./ui/BotTokenLoginModal";

let unpatches: Array<() => void> = [];

export const preenabled = true;

export default defineCorePlugin({
    manifest: {
        id: "bunny.botclient",
        name: "DiscordBotClient",
        version: DBC_VERSION,
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
            patchRootBotLoginUI(),
            registerBotClientCommands()
        ];
    },
    stop() {
        for (const unpatch of unpatches) {
            try {
                unpatch();
            } catch {
                // Ignore cleanup error
            }
        }
        unpatches = [];
    },
    SettingsComponent: BotClientSettings
});
