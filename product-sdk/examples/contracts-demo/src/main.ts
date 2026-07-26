// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Entry point for the @parity/product-sdk-contracts E2E demo.
 *
 * Wires up SignerManager + chain-client + ContractManager against the
 * t3rminal @t3rminal/bulletin-index contract deployed on Paseo Asset Hub.
 *
 * Contract address: 0xD35CFc6E9F07B42Cc524A9Fa4A001F6ac90586E2 (redeployed)
 *
 * Exercises the two core host-API paths in @parity/product-sdk-contracts:
 *   - query()  — dry-run via chain RPC (no signing)
 *   - tx()     — signed extrinsic via host_create_transaction 
 *
 * Flow inside the host-api-test-sdk test host:
 *   1. SignerManager.connect() establishes the HostProvider session.
 *   2. manager.getProductAccount("contracts-demo.dot", 0) asks the host for
 *      a DotNS-derived product account. The fixture maps
 *      "contracts-demo.dot/0" to Bob's funded keypair via `productAccounts`.
 *   3. getChainAPI("paseo") routes RPC through the host's chainConnection
 *      handler.
 *   4. ContractManager.fromClient(cdm, chain.raw.assetHub) wraps the contract.
 *   5. contract.getReportCount.query(shopKey) → dry-run via RPC — no signing.
 *   6. contract.storeDailyReport.tx(shopKey, date, cid, count) uses
 *      productAccount.getSigner() — which routes through the host's
 *      `createTransaction` path and preserves arbitrary signed extensions
 *      (e.g. AsPgas on Paseo Next).
 *
 * This demo signs with an app-scoped product account. The legacy-account
 * path (`manager.connect()` + `selectAccount` + `manager.getSigner()`)
 * works too — both go through the host's create-transaction path and
 * preserve unknown signed extensions.
 *
 * ── commons mode (readiness-harness Task 5.3, additive) ────────────────
 * The default behaviour above is unchanged. `e2e/fixtures.commons.ts` uses
 * Playwright's `page.addInitScript()` to set `window.__COMMONS_GENESIS_HASH__`
 * before the product iframe ever navigates — that (rather than a URL query
 * param) is what switches the chain client to cord-commons instead of Paseo
 * Asset Hub. (A `?network=`/`?genesis=` query-string approach was tried
 * first and doesn't work: the installed `@parity/host-api-test-sdk@0.11.0`
 * computes the iframe's FIRST `src` as
 * `new URL(hostPage.location.pathname+search+hash, productUrl).href`, and
 * since the host page itself always loads at a bare origin, that resolves
 * to just `productUrl`'s origin — silently dropping any query string,
 * confirmed by reading its `dist/host-bundle.js`. `addInitScript` sidesteps
 * this entirely — it doesn't care what URL the frame ends up at.) The
 * `@t3rminal/bulletin-index` contract this demo's query()/tx() buttons call
 * is only deployed on Paseo (its bytecode isn't available to redeploy on
 * commons — `src/cdm.json` carries only its ABI + address, not bytecode), so
 * commons mode only exercises boot + `ensureContractAccountMapped` (a real
 * signed `Revive.map_account` extrinsic against commons, requiring
 * `customSignedExtensions.VerifyMultiSignature` — see
 * `docs/integration/test-host-chainconfig.md` in the main cord-commons repo).
 * The query/tx buttons remain wired to the Paseo contract regardless of
 * network; commons e2e specs simply don't click them.
 */

import type { SignerAccount } from "@parity/product-sdk-signer";
import { SignerManager } from "@parity/product-sdk-signer";
import { getChainAPI, createChainClient } from "@parity/product-sdk-chain-client";
import {
    ContractManager,
    ensureContractAccountMapped,
    type CdmJson,
} from "@parity/product-sdk-contracts";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { commons_asset_hub } from "@parity/product-sdk-descriptors/commons-asset-hub";

import cdm from "./cdm.json";
import { appendLog, getEl } from "./ui.js";

// ── Network selection (commons mode is additive — see module doc above) ─
const COMMONS_GENESIS_HASH =
    (window as unknown as Record<string, unknown>).__COMMONS_GENESIS_HASH__ as string | undefined;
const NETWORK: "paseo" | "commons" = COMMONS_GENESIS_HASH ? "commons" : "paseo";

// `commons_asset_hub`'s checked-in descriptor pins whatever genesis hash was live the last time
// someone ran `papi generate` against a commons `--dev --tmp` node — commons regenerates genesis
// on every fresh start (docs/integration/test-host-chainconfig.md in cord-commons), so that pin
// is almost always stale by the time this runs. Clone the descriptor with `.genesis` overridden
// to the live value the fixture fetched via `chainSpec_v1_genesisHash` and passed through the
// `?genesis=` param — the compiled metadata/pallet layout is unaffected (same release binary
// backs every commons run), only the genesis-hash-keyed host routing needs to match.
const liveCommonsAssetHub =
    NETWORK === "commons" && COMMONS_GENESIS_HASH
        ? { ...commons_asset_hub, genesis: COMMONS_GENESIS_HASH }
        : null;

// ── DOM ───────────────────────────────────────────────────────────────
const $connectionStatus = getEl<HTMLSpanElement>("connection-status");
const $activeProvider = getEl<HTMLSpanElement>("active-provider");
const $accountAddress = getEl<HTMLSpanElement>("account-address");
const $reportDateInput = getEl<HTMLInputElement>("report-date-input");
const $reportCidInput = getEl<HTMLInputElement>("report-cid-input");
const $queryShopKeyInput = getEl<HTMLInputElement>("query-shopkey-input");
const $btnQueryReportCount = getEl<HTMLButtonElement>("btn-query-report-count");
const $btnQueryAllDates = getEl<HTMLButtonElement>("btn-query-all-dates");
const $btnQueryCid = getEl<HTMLButtonElement>("btn-query-cid");
const $btnStoreReport = getEl<HTMLButtonElement>("btn-store-report");
const $contractLog = getEl<HTMLElement>("contract-log");

// 32 zero bytes — a `shopKey` value that the on-chain registry has never
// minted, so every query against it yields deterministic empty results
// (0 reports, [] dates, "" CID). Used as the default for both query inputs
// and the storeDailyReport `tx()` call.
const ZERO_SHOP_KEY = "0x0000000000000000000000000000000000000000000000000000000000000000";

function setControlsEnabled(enabled: boolean): void {
    $btnQueryReportCount.disabled = !enabled;
    $btnQueryAllDates.disabled = !enabled;
    $btnQueryCid.disabled = !enabled;
    $btnStoreReport.disabled = !enabled;
    $reportDateInput.disabled = !enabled;
    $reportCidInput.disabled = !enabled;
    $queryShopKeyInput.disabled = !enabled;
}

function log(msg: string, level: Parameters<typeof appendLog>[2] = "info"): void {
    appendLog($contractLog, msg, level);
}

// ── App state ────────────────────────────────────────────────────────
const SS58_PREFIX = NETWORK === "commons" ? 29 : 0; // cord-commons vs Paseo Asset Hub

const manager = new SignerManager({ ss58Prefix: SS58_PREFIX, dappName: "contracts-demo" });

// The product account we sign all transactions with. Populated by init()
// via `manager.getProductAccount("contracts-demo.dot", 0)`. Its `getSigner()`
// routes through the host's `host_create_transaction` path so unknown
// signed extensions (e.g. AsPgas on Paseo Next) round-trip end-to-end.
let productAccount: SignerAccount | null = null;

type ChainClient =
    | Awaited<ReturnType<typeof getChainAPI<"paseo">>>
    | Awaited<ReturnType<typeof createChainClient<{ assetHub: typeof commons_asset_hub }>>>;
let chain: ChainClient | null = null;
let contractManager: ContractManager | null = null;

// ── UI subscriptions ─────────────────────────────────────────────────
manager.subscribe((state) => {
    $connectionStatus.textContent = state.status;
    $activeProvider.textContent = state.activeProvider ?? "-";
    $accountAddress.textContent = productAccount?.address ?? "-";
    const ready =
        state.status === "connected" && productAccount !== null && contractManager !== null;
    setControlsEnabled(ready);
});

// Re-render readiness when fields the manager subscription doesn't observe
// (productAccount, contractManager) change. Called at the end of init().
function renderReady(): void {
    $accountAddress.textContent = productAccount?.address ?? "-";
    const state = manager.getState();
    const ready =
        state.status === "connected" && productAccount !== null && contractManager !== null;
    setControlsEnabled(ready);
}

// ── Actions ──────────────────────────────────────────────────────────

/**
 * Query helpers that exercise the PAPI 2.x codec boundary end-to-end:
 *   - viem encodes the `bytes32` shopKey arg into the calldata `Uint8Array`,
 *   - PAPI's `ReviveApi.call` returns a `Uint8Array`,
 *   - viem decodes it back to the typed JS value.
 *
 * The default shopKey is 32 zero bytes — a value the registry has never
 * minted — so the results are deterministic regardless of accumulated
 * chain state.
 */
$btnQueryReportCount.addEventListener("click", async () => {
    if (!contractManager) {
        log("Contract manager not ready", "err");
        return;
    }
    const shopKey = $queryShopKeyInput.value || ZERO_SHOP_KEY;
    log(`Querying getReportCount(${shopKey})…`);
    try {
        const contract = contractManager.getContract("@t3rminal/bulletin-index");
        const result = await contract.getReportCount.query(shopKey);
        if (result.success) {
            log(`reportCount: ${result.value}`, "ok");
        } else {
            log("getReportCount query failed (dry-run success=false)", "err");
        }
    } catch (err) {
        log(`getReportCount failed: ${(err as Error).message}`, "err");
    }
});

$btnQueryAllDates.addEventListener("click", async () => {
    if (!contractManager) {
        log("Contract manager not ready", "err");
        return;
    }
    const shopKey = $queryShopKeyInput.value || ZERO_SHOP_KEY;
    log(`Querying getAllDates(${shopKey})…`);
    try {
        const contract = contractManager.getContract("@t3rminal/bulletin-index");
        const result = await contract.getAllDates.query(shopKey);
        if (result.success) {
            // Stringify so the test can match a stable representation of the
            // decoded `string[]` regardless of how arrays render in the DOM.
            log(`allDates: ${JSON.stringify(result.value)}`, "ok");
        } else {
            log("getAllDates query failed (dry-run success=false)", "err");
        }
    } catch (err) {
        log(`getAllDates failed: ${(err as Error).message}`, "err");
    }
});

$btnQueryCid.addEventListener("click", async () => {
    if (!contractManager) {
        log("Contract manager not ready", "err");
        return;
    }
    const shopKey = $queryShopKeyInput.value || ZERO_SHOP_KEY;
    const date = $reportDateInput.value || "2026-01-01";
    log(`Querying getCID(${shopKey}, "${date}")…`);
    try {
        const contract = contractManager.getContract("@t3rminal/bulletin-index");
        const result = await contract.getCID.query(shopKey, date);
        if (result.success) {
            log(`cid: ${JSON.stringify(result.value)}`, "ok");
        } else {
            log("getCID query failed (dry-run success=false)", "err");
        }
    } catch (err) {
        log(`getCID failed: ${(err as Error).message}`, "err");
    }
});

/**
 * Signed transaction — calls storeDailyReport(shopKey, date, cid, count).
 * The contract is permissionless: any caller stores a report under the
 * given shopKey (subject to the upstream registry/shop-ownership rules
 * enforced inside the contract). Exercises the full host-signing path.
 */
$btnStoreReport.addEventListener("click", async () => {
    if (!contractManager) {
        log("Contract manager not ready", "err");
        return;
    }
    if (!productAccount) {
        log("Product account not ready", "err");
        return;
    }
    const signer = productAccount.getSigner();

    const shopKey = $queryShopKeyInput.value || ZERO_SHOP_KEY;
    const date = $reportDateInput.value || "2026-01-01";
    const cid = $reportCidInput.value || "bafktest";

    setControlsEnabled(false);
    log(`Submitting storeDailyReport(${shopKey}, "${date}", "${cid}", 1)…`);

    try {
        const contract = contractManager.getContract("@t3rminal/bulletin-index");
        const result = await contract.storeDailyReport.tx(shopKey, date, cid, 1n, { signer });
        if (result.ok) {
            log(
                `storeDailyReport landed in block #${result.value.block.number} (${result.value.txHash.slice(0, 18)}…)`,
                "ok",
            );
        } else {
            log(`storeDailyReport failed: ${result.error.name}: ${result.error.message}`, "err");
        }
    } catch (err) {
        log(`storeDailyReport failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

// ── Boot ─────────────────────────────────────────────────────────────
async function init() {
    log("Booting contracts-demo…");

    // Step 1: establish the host session. This demo signs with an app-scoped
    // product account via `getProductAccountSigner` (the host's
    // create-transaction path, which preserves unknown signed extensions like
    // AsPgas on Paseo Next).
    log("Connecting signer…");
    const connectRes = await manager.connect();
    if (!connectRes.ok) {
        log(`Signer connect failed: ${connectRes.error.message}`, "err");
        return;
    }

    // Step 2: request the product account. The fixture maps
    // "contracts-demo.dot/0" → bob via `productAccounts`, so this returns
    // Bob's funded account but signs through host_create_transaction.
    log("Requesting product account contracts-demo.dot/0…");
    const productRes = await manager.getProductAccount("contracts-demo.dot", 0);
    if (!productRes.ok) {
        log(`getProductAccount failed: ${productRes.error.message}`, "err");
        return;
    }
    productAccount = productRes.value;
    log(`Product account ready: ${productAccount.address}`, "ok");

    log(`Opening chain client (network=${NETWORK})…`);
    try {
        if (NETWORK === "commons") {
            if (!liveCommonsAssetHub) {
                throw new Error("network=commons but no ?genesis= param supplied");
            }
            chain = await createChainClient({ chains: { assetHub: liveCommonsAssetHub } });
        } else {
            chain = await getChainAPI("paseo");
        }
        log("Chain client ready", "ok");
    } catch (err) {
        log(`Chain client failed: ${(err as Error).message}`, "err");
        return;
    }

    log("Initialising ContractManager…");
    try {
        // `ContractManager.fromClient` builds a runtime that routes the
        // `ReviveApi.call` dry-run through PAPI's unsafe API, sidestepping
        // compatibility-token failures when the descriptor lags a chain
        // upgrade. Pass the raw client + descriptor so it can wire up both
        // typed (extrinsics + storage) and unsafe (dry-run) paths. This is
        // lazy — it does not touch the network, so it succeeds on commons
        // even though the `@t3rminal/bulletin-index` contract itself isn't
        // deployed there (see the module doc).
        contractManager = ContractManager.fromClient(
            cdm as CdmJson,
            chain.raw.assetHub,
            NETWORK === "commons" ? (liveCommonsAssetHub as typeof commons_asset_hub) : paseo_asset_hub,
            { signerManager: manager },
        );
        log("ContractManager ready (@t3rminal/bulletin-index)", "ok");
    } catch (err) {
        log(`ContractManager failed: ${(err as Error).message}`, "err");
        return;
    }

    // `pallet-revive` rejects `Revive.call` from any SS58 origin that hasn't
    // been mapped to its derived H160 via `Revive.map_account()`. The helper
    // is idempotent — short-circuits on a storage hit — so the first-time
    // path costs one signature and subsequent boots are free. The
    // `Revive.map_account` extrinsic also carries AsPgas on Paseo Next, so
    // it must sign through the product-account path too.
    try {
        const signer = productAccount.getSigner();
        log("Ensuring account is mapped on pallet-revive…");
        const mapped = await ensureContractAccountMapped(
            contractManager.getRuntime(),
            productAccount.address,
            signer,
            // commons wires pallet_verify_signature's VerifySignature extension into every
            // extrinsic (TxExtension) — PAPI's dynamic signer only auto-fills a fixed whitelist
            // that doesn't include it, so every signed call against commons must supply the
            // disabled/passthrough value explicitly or PAPI throws "Missing VerifyMultiSignature
            // signed extension" (docs/integration/test-host-chainconfig.md in cord-commons).
            NETWORK === "commons"
                ? { customSignedExtensions: { VerifyMultiSignature: { value: { type: "Disabled" } } } }
                : undefined,
        );
        if (!mapped.ok) {
            log(`ensureContractAccountMapped failed: ${mapped.error.message}`, "err");
            return;
        }
        log(
            mapped.value === null
                ? "Account already mapped (no signature needed)"
                : `Account mapped in block #${mapped.value.block.number}`,
            "ok",
        );
    } catch (err) {
        log(`ensureContractAccountMapped failed: ${(err as Error).message}`, "err");
        return;
    }

    renderReady();
}

init().catch((err) => log(`Unhandled init error: ${(err as Error).message}`, "err"));
