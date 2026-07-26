// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test as base } from "@playwright/test";
import {
    createTestHostFixture,
    type NetworkConfig,
    type TestHost,
} from "@parity/host-api-test-sdk/playwright";

// cord-commons SS58 prefix (readiness-harness plan decision D9) — addresses look nothing like
// Paseo's ("1..."); no fixed leading character to assert on the way `fixtures.ts`'s
// `SS58_PREFIX = 0` does, so boot.commons.spec.ts only checks the address is non-empty.
export const SS58_PREFIX = 29;

const PRODUCT_URL = "http://localhost:5201";

const COMMONS_WS = process.env.COMMONS_WS;
const COMMONS_GENESIS_HASH = process.env.COMMONS_GENESIS_HASH;
if (!COMMONS_WS || !COMMONS_GENESIS_HASH) {
    throw new Error(
        "fixtures.commons.ts requires COMMONS_WS and COMMONS_GENESIS_HASH env vars — " +
            "scripts/readiness/suite-sdk.sh sets both (genesis fetched live via " +
            "chainSpec_v1_genesisHash, since commons regenerates genesis on every fresh " +
            "--dev/--tmp start; see docs/integration/test-host-chainconfig.md in cord-commons).",
    );
}

// NOTE on `networks:` vs `chain:`: every OTHER fixtures.ts in this repo passes a `chain: {...}`
// object to `createTestHostFixture` and imports a `ChainConfig` type that doesn't actually exist
// in the installed `@parity/host-api-test-sdk@0.11.0` (`CreateTestHostOptions` only has
// `networks?: NetworkConfig[]` — confirmed by reading
// `node_modules/@parity/host-api-test-sdk/dist/playwright/fixture.js`:
// `networks: defaults.networks ?? [DEFAULT_CHAIN]`, no `.chain` read anywhere). Those `chain:`
// values are silently-ignored dead code today (every existing demo actually still talks to
// whatever `DEFAULT_CHAIN`/`PASEO_ASSET_HUB` is baked into the installed package, regardless of
// e.g. `PASEO_AH_RPC`). We use the real `networks:` field so commons is actually registered with
// the test host and routed to.
const COMMONS_NETWORK: NetworkConfig = {
    id: "commons",
    name: "CORD Commons (local)",
    genesisHash: COMMONS_GENESIS_HASH as `0x${string}`,
    rpcUrl: COMMONS_WS,
    tokenSymbol: "CMON",
    tokenDecimals: 10,
};

const rawFixture = createTestHostFixture({
    productUrl: PRODUCT_URL,
    accounts: ["bob"],
    networks: [COMMONS_NETWORK],
    productAccounts: { "contracts-demo.dot/0": "bob" },
});

// `src/main.ts` picks commons mode by checking `window.__COMMONS_GENESIS_HASH__` rather than a
// `?genesis=` URL query param — the installed `@parity/host-api-test-sdk@0.11.0` has a confirmed
// bug where the test host's FIRST iframe navigation computes `src` as
// `new URL(hostPage.location.pathname+search+hash, productUrl).href`; since the host page always
// loads at a bare origin, that resolves to just `productUrl`'s origin, silently dropping any
// query string (read live in `dist/host-bundle.js`'s `iB()` — confirmed via an ad hoc
// instrumented run during this task, not just static reading). `page.addInitScript()` runs
// before ANY navigation on this page (including the iframe's first one) and isn't subject to
// that bug, so it's the reliable way to hand the product page runtime config here.
export const test = base.extend<{ testHost: TestHost }>({
    testHost: async ({ page }, use) => {
        await page.addInitScript((genesisHash) => {
            (window as unknown as Record<string, unknown>).__COMMONS_GENESIS_HASH__ = genesisHash;
        }, COMMONS_GENESIS_HASH);
        await rawFixture.testHost({ page }, use);
    },
});
export { expect } from "@playwright/test";
