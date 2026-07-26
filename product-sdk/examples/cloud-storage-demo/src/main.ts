// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Entry point for the @parity/product-sdk-cloud-storage demo.
 *
 * Wires up SignerManager (account discovery) + CloudStorageClient (against the
 * cloud storage via @parity/bulletin-sdk's AsyncBulletinClient).
 *
 * Flow:
 *   1. SignerManager.connect() → HostProvider → account
 *   2. CloudStorageClient.create() with a lazy signer
 *   3. .store(data).send() → signed TransactionStorage.store extrinsic
 *   4. .fetchBytes(cid) → host preimage subscription (container-only)
 *
 * ── commons mode (readiness-harness Task 5.3, additive) ────────────────
 * The default behaviour above is unchanged. `e2e/fixtures.commons.ts` sets
 * `window.__COMMONS_GENESIS_HASH__` (via Playwright's `page.addInitScript()`,
 * before the product iframe ever navigates — see contracts-demo/src/main.ts's
 * identical note for why a URL query param doesn't work with the installed
 * `@parity/host-api-test-sdk@0.11.0`) — its presence switches
 * `CloudStorageClient.create()` to cord-commons's bulletin role
 * (explicit-descriptor form) instead of the `environment: "paseo"` shorthand.
 *
 * `.store(data).send()` is NOT exercised in commons mode: the vendored
 * `@parity/bulletin-sdk@0.3.0` calls `tx.signSubmitAndWatch(this.signer)`
 * with no options argument (see its `dist/index.js`,
 * `signAndSubmitWithProgress`), so there is no way to supply
 * `customSignedExtensions.VerifyMultiSignature` — required on every signed
 * call against commons (`docs/integration/test-host-chainconfig.md` in
 * cord-commons). That's an upstream `@parity/bulletin-sdk` gap, not
 * something `@parity/product-sdk-cloud-storage` (or this fork) controls.
 * `checkAuthorization()` (a read, no signing) is exposed on `__BULLETIN__`
 * for commons e2e specs to exercise instead.
 */

import { SignerManager } from "@parity/product-sdk-signer";
import {
    CloudStorageClient,
    calculateCid,
    cidToPreimageKey,
    createLazySigner,
} from "@parity/product-sdk-cloud-storage";
import { commons_bulletin } from "@parity/product-sdk-descriptors/commons-bulletin";

import { appendLog, getEl } from "./ui.js";

// ── Network selection (commons mode is additive — see module doc above) ─
const COMMONS_GENESIS_HASH =
    (window as unknown as Record<string, unknown>).__COMMONS_GENESIS_HASH__ as string | undefined;
const NETWORK: "paseo" | "commons" = COMMONS_GENESIS_HASH ? "commons" : "paseo";

// See contracts-demo/src/main.ts's identical comment: commons regenerates genesis on every
// fresh `--dev`/`--tmp` start, so the checked-in descriptor's pinned `.genesis` is almost always
// stale. Override it with the live value the fixture fetched and passed via `?genesis=`.
const liveCommonsBulletin =
    NETWORK === "commons" && COMMONS_GENESIS_HASH
        ? { ...commons_bulletin, genesis: COMMONS_GENESIS_HASH }
        : null;

// ── DOM ───────────────────────────────────────────────────────────────
const $connectionStatus = getEl<HTMLSpanElement>("connection-status");
const $activeProvider = getEl<HTMLSpanElement>("active-provider");
const $accountAddress = getEl<HTMLSpanElement>("account-address");
const $bulletinStatus = getEl<HTMLSpanElement>("bulletin-status");
const $uploadInput = getEl<HTMLInputElement>("upload-input");
const $btnUpload = getEl<HTMLButtonElement>("btn-upload");
const $queryCidInput = getEl<HTMLInputElement>("query-cid-input");
const $btnQuery = getEl<HTMLButtonElement>("btn-query");
const $lastCid = getEl<HTMLSpanElement>("last-cid");
const $lastBlockHash = getEl<HTMLSpanElement>("last-block");
const $queryResult = getEl<HTMLSpanElement>("query-result");
const $log = getEl<HTMLElement>("bulletin-log");

function setControlsEnabled(enabled: boolean): void {
    $uploadInput.disabled = !enabled;
    $btnUpload.disabled = !enabled;
    $queryCidInput.disabled = !enabled;
    $btnQuery.disabled = !enabled;
}

function log(msg: string, level: Parameters<typeof appendLog>[2] = "info"): void {
    appendLog($log, msg, level);
}

// ── App state ────────────────────────────────────────────────────────
const SS58_PREFIX = NETWORK === "commons" ? 29 : 0; // cord-commons vs Paseo Asset Hub
const manager = new SignerManager({ ss58Prefix: SS58_PREFIX, dappName: "bulletin-demo" });
let bulletinClient: CloudStorageClient | null = null;

// ── UI subscriptions ─────────────────────────────────────────────────
manager.subscribe((state) => {
    $connectionStatus.textContent = state.status;
    $activeProvider.textContent = state.activeProvider ?? "-";
    $accountAddress.textContent = state.selectedAccount?.address ?? "-";
});

// ── Actions ──────────────────────────────────────────────────────────
$btnUpload.addEventListener("click", async () => {
    if (!bulletinClient) {
        log("CloudStorageClient not ready", "err");
        return;
    }
    const text = $uploadInput.value || "hello";
    const data = new TextEncoder().encode(text);
    setControlsEnabled(false);
    log(`Uploading: "${text}" (${data.length} bytes)…`);

    try {
        const result = await bulletinClient.store(data).send();
        const cid = result.cid?.toString() ?? "(no manifest CID)";
        $lastCid.textContent = cid;
        $queryCidInput.value = cid;

        const blockNumber = result.blockNumber !== undefined ? `#${result.blockNumber}` : "-";
        $lastBlockHash.textContent = blockNumber;
        log(
            `Uploaded: CID=${cid.slice(0, 20)}… block=${blockNumber} size=${result.size} bytes`,
            "ok",
        );
    } catch (err) {
        log(`Upload failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

$btnQuery.addEventListener("click", async () => {
    if (!bulletinClient) {
        log("CloudStorageClient not ready", "err");
        return;
    }
    const cid = $queryCidInput.value;
    if (!cid) {
        log("No CID to query — upload first", "err");
        return;
    }
    setControlsEnabled(false);
    log(`Querying: CID=${cid.slice(0, 20)}…`);

    try {
        const result = await bulletinClient.fetchBytes(cid);
        if (!result.ok) {
            log(`Query failed: ${result.error.message}`, "err");
            return;
        }
        const bytes = result.value;
        const text = new TextDecoder().decode(bytes);
        $queryResult.textContent = text;
        log(`Query result (${bytes.length} bytes): "${text}"`, "ok");
    } catch (err) {
        log(`Query failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

// ── Boot ─────────────────────────────────────────────────────────────
async function init() {
    log("Booting bulletin-demo…");

    // Step 1: connect signer (HostProvider inside the test host)
    log("Connecting signer…");
    const connectRes = await manager.connect();
    if (!connectRes.ok) {
        log(`Signer connect failed: ${connectRes.error.message}`, "err");
        return;
    }
    const accounts = connectRes.value;
    if (accounts.length === 0) {
        log("No accounts exposed by the host", "err");
        return;
    }
    const selectRes = manager.selectAccount(accounts[0].address);
    if (!selectRes.ok) {
        log(`selectAccount failed: ${selectRes.error.message}`, "err");
        return;
    }
    log(`Signer ready: ${accounts[0].address}`, "ok");

    // Step 2: create CloudStorageClient with a lazy signer that resolves
    // through the SignerManager on every sign call.
    log(`Creating CloudStorageClient (network=${NETWORK})…`);
    try {
        bulletinClient =
            NETWORK === "commons" && liveCommonsBulletin
                ? await CloudStorageClient.create({
                      genesisHash: liveCommonsBulletin.genesis as `0x${string}`,
                      // The explicit-form option type is pinned to
                      // `(typeof CloudStorageNetworks)[CloudStorageEnvironment]["descriptor"]`
                      // (Paseo's bulletin descriptor's TS type) — commons_bulletin is a
                      // structurally-equivalent Bulletin-pallet descriptor generated against a
                      // different chain, so it's a different nominal generated type. Cast at the
                      // boundary; the runtime shape (descriptors/metadataTypes/genesis/getMetadata)
                      // is what actually matters and matches.
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      descriptor: liveCommonsBulletin as any,
                      signer: createLazySigner(() => manager.getSigner()),
                  })
                : await CloudStorageClient.create({
                      environment: "paseo",
                      signer: createLazySigner(() => manager.getSigner()),
                  });
        $bulletinStatus.textContent = "connected";
        log("CloudStorageClient ready", "ok");
    } catch (err) {
        $bulletinStatus.textContent = "error";
        log(`CloudStorageClient init failed: ${(err as Error).message}`, "err");
        return;
    }

    // Expose utilities for manual debugging in the browser console, and for e2e specs to drive
    // read-only checks that have no dedicated UI (e.g. checkAuthorization — see commons e2e
    // module doc above for why commons mode doesn't wire a store()/upload UI path).
    (window as unknown as Record<string, unknown>).__BULLETIN__ = {
        calculateCid,
        cidToPreimageKey,
        client: bulletinClient,
    };

    // Ready — enable controls
    setControlsEnabled(true);
    log("Ready", "ok");
}

init().catch((err) => log(`Unhandled init error: ${(err as Error).message}`, "err"));
