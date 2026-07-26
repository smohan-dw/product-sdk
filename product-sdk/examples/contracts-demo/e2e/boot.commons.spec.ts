// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "./fixtures.commons";
import { waitForAppReady } from "./helpers";

/**
 * cord-commons readiness-harness spec (Task 5.3) — contracts-demo via the real Host API path,
 * against a local commons node instead of Paseo Asset Hub.
 *
 * Covered here: host connection, `SignerManager` + product-account resolution,
 * `ContractManager.fromClient()` init (lazy — no network touch), and
 * `ensureContractAccountMapped()` — a REAL signed `Revive.map_account()` extrinsic against
 * commons, exercising the full host-signing path plus the
 * `customSignedExtensions.VerifyMultiSignature` passthrough every signed call against commons
 * needs (see `src/main.ts`'s module doc and `docs/integration/test-host-chainconfig.md` in
 * cord-commons).
 *
 * NOT covered here (intentionally, documented in `task-5.3-report.md`): the
 * `@t3rminal/bulletin-index` contract query()/tx() buttons that `query.spec.ts` /
 * `submit.spec.ts` exercise against Paseo. That contract is a third-party CDM package
 * (`src/cdm.json` carries only its ABI + a Paseo address, no bytecode) — there is nothing to
 * redeploy on commons, and no other commons-deployed Revive contract this demo knows how to
 * call. `waitForAppReady()` still asserts those buttons end up *enabled* (ContractManager ready
 * for ANY contract call), just not that a call against this specific undeployed contract
 * succeeds.
 */
test.describe("@parity/product-sdk-contracts via Host API — boot (commons)", () => {
    test("app connects, resolves a product account, and maps it on commons pallet-revive", async ({
        testHost,
    }) => {
        const frame = await waitForAppReady(testHost, { timeout: 120_000 });

        const address = await frame.locator('[data-testid="account-address"]').textContent();
        expect(address).toBeTruthy();
        expect(address!.trim()).not.toBe("-");

        const provider = await frame.locator('[data-testid="active-provider"]').textContent();
        expect(provider?.trim()).not.toBe("-");

        // waitForAppReady already asserts the contract-log contains "ContractManager ready" and
        // that every action button is enabled — which only happens after init()'s
        // ensureContractAccountMapped() step against commons succeeds (see src/main.ts). Assert
        // the specific mapping outcome line too, so a silent readiness-check drift (e.g. a
        // future change that enables buttons before mapping finishes) doesn't hide a real
        // mapping failure.
        await expect(frame.locator('[data-testid="contract-log"]')).toContainText(
            /Account (already mapped|mapped in block #\d+)/i,
        );
    });
});
