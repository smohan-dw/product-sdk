// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { cryptoWaitReady } from "@polkadot/util-crypto";

import { test, expect } from "./fixtures.commons";
import { waitForAppReady } from "./helpers";

/**
 * cord-commons readiness-harness spec (Task 5.3) — cloud-storage-demo via the real Host API
 * path, against a local commons node instead of Paseo Asset Hub.
 *
 * Covered here: host connection (as "Eve" — see the authorization note below for what that
 * name actually resolves to), `CloudStorageClient.create()` against commons's bulletin role
 * (explicit BYOD-descriptor form, live genesis override — see `src/main.ts`'s module doc), and
 * `checkAuthorization()` — a REAL read of `TransactionStorage.Authorizations` on commons,
 * proving an on-chain quota round-trips through the SDK's commons connection correctly.
 *
 * Authorization note: `scripts/bootstrap-local-platform.mjs` authorizes the CONVENTIONAL
 * substrate dev account `//Eve` (from the standard dev phrase). The installed
 * `@parity/host-api-test-sdk@0.11.0`'s own "eve"/named-account keys do NOT derive that same
 * account — confirmed live during this task (its `"eve"` and an explicit
 * `"<dev phrase>//Eve"` URI both produced the identical, but DIFFERENT, address; its internal
 * keyring evidently keys off the trailing `//Eve` alone rather than deriving from the URI as a
 * whole). Rather than fight that (a third-party test harness's own crypto, out of this fork's
 * control), `ensureBulletinAuthorized` below grants THAT specific address a fresh
 * `TransactionStorage` authorization directly (same
 * `Sudo.sudo(TransactionStorage.authorize_account(...))` call bootstrap-local-platform.mjs
 * makes, signed by `//Alice` — sudo on every dev preset), idempotently. What's being proven is
 * unaffected either way: that `checkAuthorization()` correctly reads whatever account is
 * actually connected, against commons, through the SDK's BYOD path.
 *
 * The write above and the `checkAuthorization()` read below go over two INDEPENDENT WS
 * connections (this test file's own PAPI client vs. the browser's, inside the iframe) — on this
 * chain's 500ms blocks, the read's connection can momentarily lag behind having observed the
 * write's connection's already-included block. `expect.poll` below absorbs that (confirmed live
 * during this task: an immediate one-shot read raced and returned `authorized: false` once
 * against a freshly-authorized address; polling a few times a beat apart resolved it every time
 * after).
 *
 * NOT covered here (documented, not silently dropped — see `task-5.3-report.md`): a real
 * `.store(data).send()` against commons. The vendored `@parity/bulletin-sdk@0.3.0` calls
 * `tx.signSubmitAndWatch(this.signer)` with no options argument (its `dist/index.js`,
 * `signAndSubmitWithProgress`), so there is no way to supply
 * `customSignedExtensions.VerifyMultiSignature` — required on every signed call against commons
 * (`docs/integration/test-host-chainconfig.md` in cord-commons; confirmed live in
 * `scripts/papi-signed-smoke.mjs`). This is an upstream `@parity/bulletin-sdk` gap: its public
 * `ClientConfig` has no `customSignedExtensions` hook at all, so no product-sdk-side or
 * demo-side change can route it through — it needs an upstream PR to `@parity/bulletin-sdk` (or
 * forking it), out of this task's scope.
 */

const COMMONS_WS = process.env.COMMONS_WS!;

/**
 * Grant `address` a `TransactionStorage` authorization on commons, mirroring
 * `scripts/bootstrap-local-platform.mjs`'s own `Sudo.sudo(TransactionStorage.authorize_account)`
 * call exactly (same disabled/passthrough `VerifyMultiSignature` encoding — every signed call
 * against commons needs it, `docs/integration/test-host-chainconfig.md`). Idempotent: a no-op if
 * `address` already has an authorization.
 */
async function ensureBulletinAuthorized(address: string): Promise<void> {
    await cryptoWaitReady();
    const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
    const kAlice = derive("//Alice");
    const sAlice = getPolkadotSigner(kAlice.publicKey, "Sr25519", kAlice.sign);

    const client = createClient(getWsProvider(COMMONS_WS));
    try {
        const papi = client.getUnsafeApi();
        const existing = await papi.query.TransactionStorage.Authorizations.getValue({
            type: "Account",
            value: address,
        });
        if (existing !== undefined) return; // already authorized — nothing to do

        const disabled = { value: new Uint8Array([0]), additionalSigned: new Uint8Array() };
        const inner = papi.tx.TransactionStorage.authorize_account({
            who: address,
            transactions: 1000,
            bytes: 100_000_000n,
        });
        const tx = papi.tx.Sudo.sudo({ call: inner.decodedCall });
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                sub.unsubscribe();
                reject(new Error("ensureBulletinAuthorized: timed out after 30s"));
            }, 30_000);
            const sub = tx
                .signSubmitAndWatch(sAlice, { customSignedExtensions: { VerifyMultiSignature: disabled } })
                .subscribe({
                    next: (ev) => {
                        if ((ev.type === "txBestBlocksState" && ev.found) || ev.type === "finalized") {
                            clearTimeout(timer);
                            sub.unsubscribe();
                            resolve();
                        }
                    },
                    error: (e) => {
                        clearTimeout(timer);
                        reject(e);
                    },
                });
        });
    } finally {
        client.destroy();
    }
}

test.describe("@parity/product-sdk-cloud-storage via Host API — boot (commons)", () => {
    test("app connects and CloudStorageClient is ready against commons", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost, { timeout: 120_000 });

        const address = await frame.locator('[data-testid="account-address"]').textContent();
        expect(address).toBeTruthy();
        expect(address!.trim()).not.toBe("-");
    });

    test("checkAuthorization() reports a granted on-chain quota", async ({ testHost }) => {
        const frame = await waitForAppReady(testHost, { timeout: 120_000 });
        const address = (await frame.locator('[data-testid="account-address"]').textContent())!.trim();

        await ensureBulletinAuthorized(address);

        // checkAuthorization() is a read (TransactionStorage.Authorizations query) — no signing,
        // so it's unaffected by the store()/send() blocker documented above. Driven via
        // `window.__BULLETIN__` (main.ts exposes it for exactly this: read-only checks with no
        // dedicated UI in commons mode).
        const readAuthorization = () =>
            frame.locator("body").evaluate(async (_, addr) => {
                const b = (window as unknown as Record<string, unknown>).__BULLETIN__ as {
                    client: {
                        checkAuthorization: (
                            address: string,
                        ) => Promise<
                            | { ok: true; value: { authorized: boolean; remainingBytes: string | number | bigint } }
                            | { ok: false; error: { message: string } }
                        >;
                    };
                };
                const result = await b.client.checkAuthorization(addr);
                if (!result.ok) throw new Error(`checkAuthorization failed: ${result.error.message}`);
                // BigInt doesn't survive Playwright's evaluate() serialization — stringify it.
                return { authorized: result.value.authorized, remainingBytes: String(result.value.remainingBytes) };
            }, address);

        // Poll rather than a one-shot read — see the cross-connection propagation note above.
        let status = await readAuthorization();
        await expect
            .poll(async () => {
                status = await readAuthorization();
                return status.authorized;
            }, { timeout: 10_000, intervals: [300, 500, 1000] })
            .toBe(true);

        expect(BigInt(status.remainingBytes)).toBeGreaterThan(0n);
    });
});
