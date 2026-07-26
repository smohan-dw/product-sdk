// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { ChainDefinition, PolkadotClient } from "polkadot-api";
import { createClient } from "polkadot-api";
import { createLogger } from "@parity/product-sdk-logger";
import { ChainNotSupportedError } from "@parity/product-sdk-host";
import { createProvider } from "./providers.js";
import { getClientCache, clearClientCache } from "./hmr.js";
import type { ChainEntry, ChainClientConfig, ChainClient } from "./types.js";

const log = createLogger("chain-client");

/**
 * Build a stand-in for a chain the host can't serve. Any property access (e.g.
 * `.query`, `.tx`) or call throws the original {@link ChainNotSupportedError},
 * so touching an unsupported chain surfaces a clear, detectable error rather
 * than hanging — without tanking the supported chains in the same client.
 */
function unsupportedChainApi(error: ChainNotSupportedError): never {
    const handler: ProxyHandler<() => void> = {
        get: () => {
            throw error;
        },
        apply: () => {
            throw error;
        },
    };
    return new Proxy((() => {}) as () => void, handler) as never;
}

// Cache keys are scoped by role name + a fingerprint of the config, so that
// (a) two `createChainClient` calls with different chain sets don't collide,
// and (b) multiple roles that share a genesis (e.g. cord-commons serving
// assetHub/bulletin/individuality off one chain) each get their own cache
// entry instead of silently aliasing onto a single client — otherwise only
// one of the N underlying clients is ever destroyed, leaking the rest.
const cacheKey = (name: string, fingerprint: string, genesis: string) =>
    `${name}:${fingerprint}:${genesis}`;

function findEntryByGenesis(genesis: string): ChainEntry | undefined {
    for (const [key, entry] of getClientCache()) {
        if (key.endsWith(`:${genesis}`)) return entry;
    }
}

const clientInstances = new Map<string, Promise<ChainClient<any>>>();

/** Build a stable fingerprint from sorted chain names + genesis hashes. */
function configFingerprint(chains: Record<string, ChainDefinition>): string {
    return Object.entries(chains)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, desc]) => `${name}:${desc.genesis ?? "unknown"}`)
        .join("|");
}

/**
 * Create a multi-chain client with user-provided descriptors and RPC endpoints.
 *
 * Returns fully-typed APIs for each chain plus raw `PolkadotClient` access via `.raw`.
 * Connections route through the host provider (`@parity/product-sdk-host`) — the SDK
 * is designed to run exclusively inside a host container (Polkadot Browser / Desktop).
 * Throws if no host provider is available; there is no direct-WebSocket fallback.
 *
 * Results are cached by genesis-hash fingerprint — calling with the same descriptors
 * returns the same instance.
 *
 * @example
 * ```ts
 * import { createChainClient } from "@parity/product-sdk-chain-client";
 * import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
 * import { paseo_bulletin } from "@parity/product-sdk-descriptors/paseo-bulletin";
 *
 * const client = await createChainClient({
 *     chains: { assetHub: paseo_asset_hub, bulletin: paseo_bulletin },
 * });
 *
 * // Fully typed from your descriptors
 * const account = await client.assetHub.query.System.Account.getValue(addr);
 * const fee = await client.bulletin.query.TransactionStorage.ByteFee.getValue();
 *
 * // Raw client for advanced use (e.g., a ContractRuntime for pallet-revive contracts)
 * import { createContractRuntimeFromClient } from "@parity/product-sdk-contracts";
 * const runtime = createContractRuntimeFromClient(client.raw.assetHub, paseo_asset_hub);
 *
 * // Cleanup
 * client.destroy();
 * ```
 */
export async function createChainClient<const TChains extends Record<string, ChainDefinition>>(
    config: ChainClientConfig<TChains>,
): Promise<ChainClient<TChains>> {
    const fingerprint = configFingerprint(config.chains);

    const existing = clientInstances.get(fingerprint);
    if (existing) return existing as Promise<ChainClient<TChains>>;

    const promise = initChainClient(config, fingerprint).catch((err) => {
        // Clean up any clients created before the failure to avoid leaking
        // WebSocket connections that are unreachable except via destroyAll().
        const cache = getClientCache();
        for (const [key, entry] of cache) {
            // Key shape is `${name}:${fingerprint}:${genesis}`; `fingerprint`
            // itself can contain colons (it's `name:genesis` pairs joined by
            // `|`), so match it as a literal middle segment rather than a prefix.
            if (key.includes(`:${fingerprint}:`)) {
                try {
                    entry.client.destroy();
                } catch {
                    /* already destroyed */
                }
                cache.delete(key);
            }
        }
        clientInstances.delete(fingerprint);
        throw err;
    });
    clientInstances.set(fingerprint, promise);
    return promise;
}

/* @integration */
async function initChainClient<const TChains extends Record<string, ChainDefinition>>(
    config: ChainClientConfig<TChains>,
    fingerprint: string,
): Promise<ChainClient<TChains>> {
    const names = Object.keys(config.chains) as (string & keyof TChains)[];
    const clientCache = getClientCache();

    // Create providers and clients in parallel
    const entries = await Promise.all(
        names.map(async (name) => {
            const descriptor = config.chains[name] as ChainDefinition;
            const genesis = descriptor.genesis;
            if (!genesis) {
                throw new Error(`Descriptor for chain "${name}" has no genesis hash.`);
            }
            try {
                const provider = await createProvider(genesis);
                const client = createClient(provider);

                // Populate HMR cache so getClient() and isConnected() work
                const key = cacheKey(name, fingerprint, genesis);
                if (!clientCache.has(key)) {
                    clientCache.set(key, {
                        client,
                        api: new Map(),
                    } satisfies ChainEntry);
                }

                return { name, descriptor, client, genesis, error: undefined };
            } catch (err) {
                // A chain the host can't serve must not tank the whole multi-chain
                // client — the supported chains stay usable, and this one surfaces a
                // clear error on first use instead of hanging. Any other failure
                // (e.g. not inside a container) is a hard error and still rejects.
                if (err instanceof ChainNotSupportedError) {
                    log.warn(
                        `Chain "${name}" is not supported by the host; its API will throw on use.`,
                        { genesis },
                    );
                    return { name, descriptor, client: null, genesis, error: err };
                }
                throw err;
            }
        }),
    );

    // Build typed APIs and raw client map. Unsupported chains get a stand-in
    // whose access throws the original ChainNotSupportedError.
    const apis = {} as Record<string, unknown>;
    const raw = {} as Record<string, PolkadotClient>;

    for (const { name, descriptor, client, error } of entries) {
        if (client) {
            apis[name] = client.getTypedApi(descriptor);
            raw[name] = client;
        } else {
            const api = unsupportedChainApi(error as ChainNotSupportedError);
            apis[name] = api;
            raw[name] = api as unknown as PolkadotClient;
        }
    }

    return {
        ...apis,
        raw,
        destroy() {
            for (const { name, genesis } of entries) {
                const key = cacheKey(name, fingerprint, genesis);
                const entry = clientCache.get(key);
                if (entry) {
                    try {
                        entry.client.destroy();
                    } catch {
                        /* already destroyed */
                    }
                    clientCache.delete(key);
                }
            }
            clientInstances.delete(fingerprint);
        },
    } as ChainClient<TChains>;
}

/**
 * Destroy all chain client instances and reset internal caches.
 *
 * Tears down every connection created by {@link createChainClient}.
 */
export function destroyAll(): void {
    clearClientCache();
    clientInstances.clear();
}

/**
 * Get the raw `PolkadotClient` for a connected chain by its descriptor.
 *
 * The chain must have been initialized via {@link createChainClient} first.
 * Alternatively, use `client.raw.<name>` on the returned {@link ChainClient}.
 *
 * @throws If the chain has not been connected yet.
 */
export function getClient(descriptor: ChainDefinition): PolkadotClient {
    const genesis = descriptor.genesis;
    if (!genesis) throw new Error("Descriptor has no genesis hash.");
    const entry = findEntryByGenesis(genesis);
    if (!entry?.client) {
        throw new Error(
            `Chain not connected (genesis: ${genesis}). Call createChainClient() first to establish connections.`,
        );
    }
    return entry.client;
}

/**
 * Check if a chain is currently connected.
 *
 * Synchronous — no side effects, no initialization.
 */
export function isConnected(descriptor: ChainDefinition): boolean {
    const genesis = descriptor.genesis;
    if (!genesis) return false;
    return findEntryByGenesis(genesis) !== undefined;
}

if (import.meta.vitest) {
    const { test, expect, beforeEach, vi } = import.meta.vitest;

    // Mock the provider + PAPI client factories so initChainClient can run without
    // a real host. Tests that pre-seed clientInstances short-circuit before these.
    vi.mock("./providers.js", () => ({ createProvider: vi.fn() }));
    vi.mock("polkadot-api", async (importOriginal) => ({
        ...(await importOriginal<typeof import("polkadot-api")>()),
        createClient: vi.fn(),
    }));

    const fakeDescriptor = { genesis: "0xtest" } as ChainDefinition;
    const fakeClient = {
        destroy: () => {},
        getTypedApi: () => ({}),
    } as unknown as PolkadotClient;

    function seedCache(genesis: string, client: PolkadotClient, fp = "test", name = "role") {
        getClientCache().set(cacheKey(name, fp, genesis), {
            client,
            api: new Map(),
        });
    }

    beforeEach(() => {
        clearClientCache();
        clientInstances.clear();
    });

    // --- isConnected ---

    test("isConnected returns false for unknown chain", () => {
        expect(isConnected(fakeDescriptor)).toBe(false);
    });

    test("isConnected returns true after cache is populated", () => {
        seedCache("0xtest", fakeClient);
        expect(isConnected(fakeDescriptor)).toBe(true);
    });

    test("isConnected returns false for descriptor without genesis", () => {
        expect(isConnected({} as ChainDefinition)).toBe(false);
    });

    // --- getClient ---

    test("getClient returns client from cache", () => {
        seedCache("0xtest", fakeClient);
        expect(getClient(fakeDescriptor)).toBe(fakeClient);
    });

    test("getClient throws for unconnected chain", () => {
        expect(() => getClient(fakeDescriptor)).toThrow(/Chain not connected/);
    });

    test("getClient throws for descriptor without genesis", () => {
        expect(() => getClient({} as ChainDefinition)).toThrow(/no genesis hash/);
    });

    // --- destroyAll ---

    test("destroyAll calls client.destroy() and clears caches", () => {
        let destroyed = false;
        const trackableClient = {
            destroy: () => {
                destroyed = true;
            },
            getTypedApi: () => ({}),
        } as unknown as PolkadotClient;
        seedCache("0xtest", trackableClient);
        clientInstances.set("test", Promise.resolve({} as ChainClient<any>));
        destroyAll();
        expect(destroyed).toBe(true);
        expect(isConnected(fakeDescriptor)).toBe(false);
        expect(clientInstances.size).toBe(0);
    });

    // --- createChainClient ---

    test("createChainClient returns same promise for identical config", async () => {
        const fakeResult = {} as ChainClient<any>;
        const fp = configFingerprint({ a: fakeDescriptor });
        clientInstances.set(fp, Promise.resolve(fakeResult));
        const result = await createChainClient({
            chains: { a: fakeDescriptor },
        });
        expect(result).toBe(fakeResult);
    });

    test("createChainClient deduplicates concurrent calls", async () => {
        const fakeResult = {} as ChainClient<any>;
        const fp = configFingerprint({ x: fakeDescriptor });
        clientInstances.set(fp, Promise.resolve(fakeResult));
        const [a, b] = await Promise.all([
            createChainClient({ chains: { x: fakeDescriptor } }),
            createChainClient({ chains: { x: fakeDescriptor } }),
        ]);
        expect(a).toBe(b);
    });

    test("createChainClient keeps supported chains usable and defers unsupported-chain errors", async () => {
        // initChainClient runs for real here — drive the mocked factories.
        const { createProvider } = await import("./providers.js");
        const { createClient } = await import("polkadot-api");
        const fakeTyped = { query: {} };
        vi.mocked(createClient).mockReturnValue({
            getTypedApi: () => fakeTyped,
            destroy: () => {},
        } as unknown as PolkadotClient);
        vi.mocked(createProvider).mockImplementation(async (genesis: string) => {
            if (genesis === "0xbad") throw new ChainNotSupportedError(genesis);
            return (() => {}) as never;
        });

        const good = { genesis: "0xgood" } as ChainDefinition;
        const bad = { genesis: "0xbad" } as ChainDefinition;
        const client = (await createChainClient({
            chains: { good, bad },
        })) as any;

        // The whole client still resolves; the supported chain is fully usable.
        expect(client.good).toBe(fakeTyped);
        // The unsupported chain surfaces the original error on use — no hang.
        expect(() => client.bad.query).toThrow(ChainNotSupportedError);
    });

    test("createChainClient returns different results for different configs", async () => {
        const descA = { genesis: "0xaaa" } as ChainDefinition;
        const descB = { genesis: "0xbbb" } as ChainDefinition;
        const resultA = {} as ChainClient<any>;
        const resultB = {} as ChainClient<any>;
        clientInstances.set(configFingerprint({ a: descA }), Promise.resolve(resultA));
        clientInstances.set(configFingerprint({ b: descB }), Promise.resolve(resultB));
        const a = await createChainClient({ chains: { a: descA } });
        const b = await createChainClient({ chains: { b: descB } });
        expect(a).not.toBe(b);
    });

    test("three roles sharing one genesis (e.g. cord-commons assetHub/bulletin/individuality) each get their own client, and destroy() tears down all three", async () => {
        // Regression test: the cache key used to be `${fingerprint}:${genesis}`,
        // so three roles resolving to the same genesis within one
        // createChainClient() call collided on a single cache entry — only one
        // of the three underlying clients was ever destroy()'d, leaking the
        // other two WebSocket connections. The key now includes the role name.
        const { createProvider } = await import("./providers.js");
        const { createClient } = await import("polkadot-api");

        let nextClientId = 0;
        const destroyedIds: number[] = [];
        vi.mocked(createProvider).mockImplementation(async () => (() => {}) as never);
        vi.mocked(createClient).mockImplementation(() => {
            const id = nextClientId++;
            return {
                getTypedApi: () => ({ id }),
                destroy: () => destroyedIds.push(id),
            } as unknown as PolkadotClient;
        });

        const sharedGenesis = "0xcommons-shared-genesis";
        const descriptor = { genesis: sharedGenesis } as ChainDefinition;
        const chains = { assetHub: descriptor, bulletin: descriptor, individuality: descriptor };
        const fp = configFingerprint(chains);

        const client = (await createChainClient({ chains })) as any;

        // Three distinct clients were created (one per role), not deduplicated.
        expect(nextClientId).toBe(3);

        // Each role has its own cache entry.
        const cache = getClientCache();
        expect(cache.has(cacheKey("assetHub", fp, sharedGenesis))).toBe(true);
        expect(cache.has(cacheKey("bulletin", fp, sharedGenesis))).toBe(true);
        expect(cache.has(cacheKey("individuality", fp, sharedGenesis))).toBe(true);

        client.destroy();

        // All three underlying clients were destroyed — not just the one that
        // happened to win the old collided cache slot.
        expect(destroyedIds.sort()).toEqual([0, 1, 2]);
        expect(cache.has(cacheKey("assetHub", fp, sharedGenesis))).toBe(false);
        expect(cache.has(cacheKey("bulletin", fp, sharedGenesis))).toBe(false);
        expect(cache.has(cacheKey("individuality", fp, sharedGenesis))).toBe(false);
    });

    // --- configFingerprint ---

    test("configFingerprint is stable regardless of key order", () => {
        const d1 = { genesis: "0x1" } as ChainDefinition;
        const d2 = { genesis: "0x2" } as ChainDefinition;
        expect(configFingerprint({ a: d1, b: d2 })).toBe(configFingerprint({ b: d2, a: d1 }));
    });

    // --- findEntryByGenesis ---

    test("findEntryByGenesis returns undefined for missing genesis", () => {
        expect(findEntryByGenesis("0xnonexistent")).toBeUndefined();
    });

    // --- full lifecycle ---

    test("full lifecycle: seed, verify connected, destroy, verify disconnected", () => {
        seedCache("0xtest", fakeClient);
        expect(isConnected(fakeDescriptor)).toBe(true);
        expect(getClient(fakeDescriptor)).toBe(fakeClient);
        destroyAll();
        expect(isConnected(fakeDescriptor)).toBe(false);
        expect(() => getClient(fakeDescriptor)).toThrow(/Chain not connected/);
    });

    test("two fingerprints cached independently, destroy one leaves other intact", () => {
        const sharedGenesis = "0xshared";
        const clientA = { destroy: () => {} } as PolkadotClient;
        const clientB = { destroy: () => {} } as PolkadotClient;
        const descriptorShared = { genesis: sharedGenesis } as ChainDefinition;

        seedCache(sharedGenesis, clientA, "fpA");
        seedCache(sharedGenesis, clientB, "fpB");

        expect(isConnected(descriptorShared)).toBe(true);

        // Destroy only fpA's entry
        const cache = getClientCache();
        const keyA = cacheKey("role", "fpA", sharedGenesis);
        cache.get(keyA)?.client.destroy();
        cache.delete(keyA);

        // fpB's entry still alive
        expect(isConnected(descriptorShared)).toBe(true);
        expect(getClient(descriptorShared)).toBe(clientB);
    });
}
