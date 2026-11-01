import { Emitter, EmitterEvent, EmitterListener, EmitterListenerData } from "@core/vendetta/Emitter";
import { NativeCacheModule, NativeFileModule } from "@lib/api/native/modules";

const emitterSymbol = Symbol.for("vendetta.storage.emitter");
const syncAwaitSymbol = Symbol.for("vendetta.storage.accessor");

export function createProxy(target: any = {}): { proxy: any; emitter: Emitter; } {
    const emitter = new Emitter();

    const childrens = new WeakMap<any, any>();
    const proxiedChildrenSet = new WeakSet<any>();

    function createProxy(target: any, path: string[]): any {
        return new Proxy(target, {
            get(target, prop: string) {
                if ((prop as unknown) === emitterSymbol) return emitter;

                const newPath = [...path, prop];
                const value: any = target[prop];

                if (value !== undefined && value !== null) {
                    emitter.emit("GET", {
                        path: newPath,
                        value,
                    });

                    if (typeof value === "object") {
                        if (proxiedChildrenSet.has(value)) return value;
                        if (childrens.has(value)) return childrens.get(value);

                        const childrenProxy = createProxy(value, newPath);
                        childrens.set(value, childrenProxy);
                        return childrenProxy;
                    }

                    return value;
                }

                return value;
            },

            set(target, prop: string, value) {
                if (typeof value === "object") {
                    if (childrens.has(value)) {
                        target[prop] = childrens.get(value);
                    } else {
                        const childrenProxy = createProxy(value, [...path, prop]);
                        childrens.set(value, childrenProxy);
                        proxiedChildrenSet.add(value);
                        target[prop] = childrenProxy;
                    }
                } else {
                    target[prop] = value;
                }

                emitter.emit("SET", {
                    path: [...path, prop],
                    value: target[prop],
                });
                // we do not care about success, if this actually does fail we have other problems
                return true;
            },

            deleteProperty(target, prop: string) {
                const value = typeof target[prop] === "object" ? childrens.get(target[prop])! : target[prop];
                const success = delete target[prop];
                if (success)
                    emitter.emit("DEL", {
                        value,
                        path: [...path, prop],
                    });
                return success;
            },
        });
    }

    return {
        proxy: createProxy(target, []),
        emitter,
    };
}

export function useProxy<T>(storage: T): T {
    const emitter = (storage as any)?.[emitterSymbol] as Emitter;
    if (!emitter) throw new Error("storage?.[emitterSymbol] is undefined");

    const [, forceUpdate] = React.useReducer(n => ~n, 0);

    React.useEffect(() => {
        const listener: EmitterListener = (event: EmitterEvent, data: EmitterListenerData) => {
            if (event === "DEL" && data.value === storage) return;
            forceUpdate();
        };

        emitter.on("SET", listener);
        emitter.on("DEL", listener);

        return () => {
            emitter.off("SET", listener);
            emitter.off("DEL", listener);
        };
    }, [emitter]);

    return storage;
}

export async function createStorage<T>(backend: StorageBackend): Promise<Awaited<T>> {
    const data = await backend.get();
    const { proxy, emitter } = createProxy(data);

    const handler = () => backend.set(proxy);
    emitter.on("SET", handler);
    emitter.on("DEL", handler);

    return proxy;
}

export function wrapSync<T extends Promise<any>>(store: T): Awaited<T> {
    let awaited: any = undefined;
    const fallback = createProxy({});

    const awaitQueue: (() => void)[] = [];
    const awaitInit = (cb: () => void) => (awaited ? cb() : awaitQueue.push(cb));

    store.then(
        v => {
            awaited = v;
            awaitQueue.forEach(cb => cb());
            fallback.emitter.emit("SET", { path: [], value: v });
        },
        err => {
            console.error("[Revenge] Failed to initialize Vendetta storage:", err);
            awaited = fallback.proxy;
            awaitQueue.forEach(cb => cb());
        }
    );

    return new Proxy({} as Awaited<T>, {
        ...Object.fromEntries(
            Object.getOwnPropertyNames(Reflect)
                // @ts-expect-error
                .map(k => [k, (t: T, ...a: any[]) => Reflect[k](awaited ?? fallback.proxy ?? t, ...a)])
        ),
        get(target, prop, recv) {
            if (prop === syncAwaitSymbol) return awaitInit;
            return Reflect.get(awaited ?? fallback.proxy ?? target, prop, recv);
        },
    });
}

export function awaitStorage(...stores: any[]) {
    return Promise.all(
        stores.map(store =>
            new Promise<void>(res => store[syncAwaitSymbol](res)))
    );
}

export interface StorageBackend {
    get: () => unknown | Promise<unknown>;
    set: (data: unknown) => void | Promise<void>;
}

const ILLEGAL_CHARS_REGEX = /[<>:"/\\|?*]/g;

const filePathFixer = (file: string): string =>
    (NativeFileModule as any)?.saveFileToGallery
        ? file
        : (globalThis as any).ReactNative?.Platform?.OS === "ios"
          ? `Documents/${file}`
          : file;

const getMMKVPath = (name: string): string => {
    if (ILLEGAL_CHARS_REGEX.test(name)) {
        // Replace forbidden characters with hyphens
        name = name.replace(ILLEGAL_CHARS_REGEX, "-").replace(/-+/g, "-");
    }

    return `vd_mmkv/${name}`;
};

export const purgeStorage = async (store: string) => {
    try {
        if (await NativeCacheModule?.getItem?.(store)) {
            NativeCacheModule?.removeItem?.(store);
        }
    } catch {}

    const mmkvPath = getMMKVPath(store);
    if (await NativeFileModule.fileExists(`${NativeFileModule.getConstants().DocumentsDirPath}/${mmkvPath}`)) {
        await NativeFileModule.removeFile?.("documents", mmkvPath);
    }
};

export const createMMKVBackend = (store: string, defaultData = {}) => {
    const mmkvPath = getMMKVPath(store);
    const defaultStr = JSON.stringify(defaultData);

    return createFileBackend(mmkvPath, defaultData, (async () => {
        try {
            const path = `${NativeFileModule.getConstants().DocumentsDirPath}/${mmkvPath}`;
            if (await NativeFileModule.fileExists(path)) return;

            let oldData: string | null = null;
            try {
                oldData = (await NativeCacheModule?.getItem?.(store)) ?? null;
            } catch {
                // Native Cache singleton may not be initialized yet during early boot
                oldData = null;
            }
            oldData ??= defaultStr;

            // From the testing on Android, it seems to return this if the data is too large
            if (oldData === "!!LARGE_VALUE!!") {
                const cachePath = `${NativeFileModule.getConstants().CacheDirPath}/mmkv/${store}`;
                if (await NativeFileModule.fileExists(cachePath)) {
                    oldData = await NativeFileModule.readFile(cachePath, "utf8");
                } else {
                    console.log(`${store}: Experienced data loss :(`);
                    oldData = defaultStr;
                }
            }

            try {
                JSON.parse(oldData);
            } catch {
                console.error(`${store} had an unparseable data while migrating`);
                oldData = defaultStr;
            }

            await NativeFileModule.writeFile("documents", filePathFixer(mmkvPath), oldData, "utf8");
            try {
                if ((await NativeCacheModule?.getItem?.(store)) !== null) {
                    NativeCacheModule?.removeItem?.(store);
                    console.log(`Successfully migrated ${store} store from MMKV storage to fs`);
                }
            } catch {}
        } catch (err) {
            console.warn(`[Revenge] MMKV migration skipped for ${store}:`, err);
        }
    })());
};

export const createFileBackend = (file: string, defaultData = {}, migratePromise?: Promise<void>): StorageBackend => {
    return {
        get: async () => {
            try {
                await migratePromise;
            } catch {}
            const path = `${NativeFileModule.getConstants().DocumentsDirPath}/${file}`;

            if (await NativeFileModule.fileExists(path)) {
                const content = await NativeFileModule.readFile(path, "utf8");
                try {
                    return JSON.parse(content);
                } catch {
                    // Corrupted content, ignore
                }
            }

            await NativeFileModule.writeFile("documents", filePathFixer(file), JSON.stringify(defaultData), "utf8");
            return JSON.parse(await NativeFileModule.readFile(path, "utf8"));
        },
        set: async data => {
            try {
                await migratePromise;
            } catch {}
            await NativeFileModule.writeFile("documents", filePathFixer(file), JSON.stringify(data), "utf8");
        }
    };
};

