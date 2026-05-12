function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function humanizeAirdropError(error: unknown): string {
  const raw = normalizeWhitespace(error instanceof Error ? error.message : String(error ?? ""));
  const lower = raw.toLowerCase();

  if (!raw) return "Transaction failed due to an unknown error.";

  if (lower.includes("invalid nonce") || lower.includes("invalid sequence")) {
    return "Another transaction used this wallet nonce first. Please retry the job.";
  }

  if (lower.includes("insufficient funds") || lower.includes("insufficient balance")) {
    return "Insufficient wallet balance to cover transfer amount and gas fee.";
  }

  if (lower.includes("execution reverted") || lower.includes("transaction reverted")) {
    return "Transaction was reverted by the network/contract. Verify token settings, recipient, and balance.";
  }

  if (lower.includes("replacement transaction underpriced")) {
    return "Replacement transaction underpriced. Wait for pending transactions to confirm, then retry.";
  }

  if (lower.includes("network error") || lower.includes("fetch failed") || lower.includes("timeout")) {
    return "RPC/network issue while sending transaction. Please retry.";
  }

  if (
    lower.includes("503") ||
    lower.includes("502") ||
    lower.includes("504") ||
    lower.includes("service temporarily unavailable") ||
    lower.includes("bad gateway") ||
    lower.includes("gateway timeout")
  ) {
    return "RPC or gateway was temporarily overloaded (502/503/504). Retries may help; reduce parallel wallets or use a dedicated RPC URL.";
  }

  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests")) {
    return "RPC rate limit hit. Wait a moment, reduce parallel sends, or use a dedicated RPC endpoint.";
  }

  const reasonMatch = raw.match(/details:\s*([^]+?)(?:version:|$)/i);
  if (reasonMatch?.[1]) {
    const reason = normalizeWhitespace(reasonMatch[1]);
    if (reason) return reason;
  }

  if (raw.length > 220) return `${raw.slice(0, 220)}...`;
  return raw;
}
