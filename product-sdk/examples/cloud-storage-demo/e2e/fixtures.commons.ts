// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test as base } from "@playwright/test";
import {
    createTestHostFixture,
    type NetworkConfig,
    type TestHost,
} from "@parity/host-api-test-sdk/playwright";

export const SS58_PREFIX = 29; // cord-commons SS58 prefix (readiness-harness plan decision D9)

const PRODUCT_URL = "http://localhost:5230";

const COMMONS_WS = process.env.COMMONS_WS;
const COMMONS_GENESIS_HASH = process.env.COMMONS_GENESIS_HASH;
if (!COMMONS_WS || !COMMONS_GENESIS_HASH) {
    throw new Error(
        "fixtures.commons.ts requires COMMONS_WS and COMMONS_GENESIS_HASH env vars — " +
            "scripts/readiness/suite-sdk.sh sets both.",
    );
}

// See contracts-demo/e2e/fixtures.commons.ts's identical note: `networks:` (not the
// upstream-pattern `chain:`, which the installed host-api-test-sdk@0.11.0 silently ignores) is
// what actually registers a chain with the test host.
const COMMONS_NETWORK: NetworkConfig = {
    id: "commons",
    name: "CORD Commons (local)",
    genesisHash: COMMONS_GENESIS_HASH as `0x${string}`,
    rpcUrl: COMMONS_WS,
    tokenSymbol: "CMON",
    tokenDecimals: 10,
};

// Named "eve" for readability only — it does NOT resolve to the conventional substrate `//Eve`
// dev key. Confirmed live during this task: the installed `@parity/host-api-test-sdk@0.11.0`'s
// named dev accounts don't derive the standard dev-phrase key at all (its `"eve"` and an
// explicit `"<dev phrase>//Eve"` URI both produced the SAME, but WRONG, address — its internal
// keyring evidently keys off the trailing `//Eve` alone, ignoring the phrase). Rather than fight
// a third-party test harness's own crypto, `boot.commons.spec.ts` grants THIS account (whatever
// address it actually is) a fresh on-chain authorization itself before asserting against it —
// see that file's header for the full note.
const rawFixture = createTestHostFixture({
    productUrl: PRODUCT_URL,
    accounts: ["eve"],
    networks: [COMMONS_NETWORK],
});

// `src/main.ts` picks commons mode via `window.__COMMONS_GENESIS_HASH__`, set below through
// `page.addInitScript()` before any navigation happens — see
// contracts-demo/e2e/fixtures.commons.ts's identical block for why a `?genesis=` URL query
// param doesn't work with the installed `@parity/host-api-test-sdk@0.11.0`.
export const test = base.extend<{ testHost: TestHost }>({
    testHost: async ({ page }, use) => {
        await page.addInitScript((genesisHash) => {
            (window as unknown as Record<string, unknown>).__COMMONS_GENESIS_HASH__ = genesisHash;
        }, COMMONS_GENESIS_HASH);
        await rawFixture.testHost({ page }, use);
    },
});
export { expect } from "@playwright/test";
