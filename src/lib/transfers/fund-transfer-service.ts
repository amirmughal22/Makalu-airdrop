/**
 * Shared on-chain fund transfer path for distributor-funded sends.
 * Used by the API (sync distribute), normalized airdrop `job_wallets`, and `fund_transfer_queue` workers.
 *
 * Implementation lives in {@link ../evm-send-transfer} — this module is the stable import surface for “fund transfer” features.
 */
export { executeEvmTransfer, readErc20Decimals } from "../evm-send-transfer";
