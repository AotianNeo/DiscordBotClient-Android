import { RNModules } from "./types";

const nmp = window.nativeModuleProxy;

function resolveNativeModule<T = any>(...names: string[]): T | undefined {
    const proxy = window.nativeModuleProxy ?? nmp;
    for (const name of names) {
        if (globalThis.__turboModuleProxy) {
            const module = globalThis.__turboModuleProxy(name);
            if (module) return module as T;
        }

        if (proxy?.[name]) return proxy[name] as T;
    }

    return undefined;
}

function getNativeModule<T = any>(...names: string[]): T | undefined {
    const immediate = resolveNativeModule<T>(...names);
    if (immediate) return immediate;

    return new Proxy({} as any, {
        get(_target, prop) {
            const mod = resolveNativeModule<any>(...names);
            if (!mod) return undefined;
            const val = mod[prop];
            return typeof val === "function" ? val.bind(mod) : val;
        }
    }) as T;
}

export const NativeCacheModule = getNativeModule<RNModules.MMKVManager>(
    "NativeCacheModule", "MMKVManager"
)!;
export const NativeFileModule = getNativeModule<RNModules.FileManager>(
    "NativeFileModule", "RTNFileManager", "DCDFileManager"
)!;
export const NativeClientInfoModule = getNativeModule<RNModules.ClientInfoModule>(
    "NativeClientInfoModule", "RTNClientInfoManager", "InfoDictionaryManager"
)!;
export const ClientInfoManager = NativeClientInfoModule;
export const NativeDeviceModule = getNativeModule(
    "NativeDeviceModule", "RTNDeviceManager", "DCDDeviceManager"
)!;
export const NativeThemeModule = getNativeModule(
    "NativeThemeModule", "RTNThemeManager", "DCDTheme"
)!;
export const BundleUpdaterManager = getNativeModule(
    "BundleUpdaterManager"
)!;
