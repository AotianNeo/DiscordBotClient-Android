import { mock } from "bun:test";

(globalThis as any).window = globalThis;
(globalThis as any).__DEV__ = true;
(globalThis as any).nativeModuleProxy = {};

mock.module("react-native", () => ({
    Linking: { openURL: () => Promise.resolve() },
    NativeModules: {},
    ScrollView: "ScrollView",
    View: "View",
    Platform: { OS: "android" }
}));

mock.module("@metro/wrappers", () => ({
    findByProps: () => ({}),
    findByPropsLazy: () => ({}),
    findByStoreName: () => ({}),
    findByStoreNameLazy: () => ({}),
    findByName: () => ({}),
    findByNameLazy: () => ({}),
    findByDisplayName: () => ({}),
    findByDisplayNameLazy: () => ({}),
    findByFilePath: () => ({}),
    findByFilePathLazy: () => ({})
}));

mock.module("@metro/common", () => ({
    FluxDispatcher: {
        dispatch: () => {}
    },
    messageUtil: {
        sendBotMessage: () => {},
        sendMessage: () => {}
    },
    commands: {
        getBuiltInCommands: () => [{ id: "-1" }]
    },
    React: {
        useState: (v: any) => [v, () => {}],
        useReducer: (v: any) => [0, () => {}],
        useEffect: () => {}
    }
}));

mock.module("@lib/ui/toasts", () => ({
    showToast: () => {}
}));

mock.module("@lib/api/assets", () => ({
    findAssetId: (name: string) => name
}));

mock.module("@lib/utils/logger", () => ({
    logger: {
        log: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error
    }
}));
