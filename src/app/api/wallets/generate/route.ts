import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { requireDistributorSession } from "@/lib/session";
import { deriveRecipientAddresses, randomRecipientAddresses } from "@/lib/derive-wallets";
import {
  randomAmountsInRangeNative,
  randomAmountsInRangeToken,
  splitTotalNativeRandom,
  splitTotalNativeSlice,
  splitTotalTokenRandom,
  splitTotalTokenSlice,
} from "@/lib/split-amounts";
import { ownerHasWallet } from "@/lib/distributor-wallet-store";

/** Max per HTTP request; client batches above this. */
const MAX_WALLETS_PER_REQUEST = 5000;
/** Max total recipients in one logical generation (batched on client). */
const MAX_WALLETS_TOTAL = 100_000;

export async function POST(request: Request) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;

  try {
    const body = (await request.json()) as {
      count?: number;
      totalAmount?: string;
      seed?: string;
      mode?: "native" | "erc20";
      deterministic?: boolean;
      /** `equalTotal`: split a fixed total. `randomRange`: each wallet gets a random amount in [minAmount, maxAmount]; sum is not fixed. */
      splitMode?: "equalTotal" | "randomRange";
      minAmount?: string;
      maxAmount?: string;
      distributorAddress?: string;
      distributorAddresses?: string[];
      /** 0-based index into a logical set of `totalCount` (batched generation). */
      offset?: number;
      /** When batching, total number of recipients across all requests (default = count). */
      totalCount?: number;
    };

    const count = Math.floor(Number(body.count));
    const offset = Math.max(0, Math.floor(Number(body.offset ?? 0)));
    const totalCount = body.totalCount != null ? Math.floor(Number(body.totalCount)) : count;

    const seed = String(body.seed ?? "default");
    const mode = body.mode === "erc20" ? "erc20" : "native";
    const deterministic = Boolean(body.deterministic);
    const splitMode = body.splitMode === "randomRange" ? "randomRange" : "equalTotal";
    const rawList =
      Array.isArray(body.distributorAddresses) && body.distributorAddresses.length > 0
        ? body.distributorAddresses
        : body.distributorAddress
          ? [body.distributorAddress]
          : [];
    const distributorAddresses = [...new Set(rawList.map((a) => String(a || "").trim().toLowerCase()).filter(Boolean))];

    if (!Number.isFinite(count) || count < 1 || count > MAX_WALLETS_PER_REQUEST) {
      return NextResponse.json(
        { error: `count must be between 1 and ${MAX_WALLETS_PER_REQUEST}` },
        { status: 400 },
      );
    }
    if (!Number.isFinite(offset) || offset < 0) {
      return NextResponse.json({ error: "offset must be a non-negative integer" }, { status: 400 });
    }
    if (!Number.isFinite(totalCount) || totalCount < 1 || totalCount > MAX_WALLETS_TOTAL) {
      return NextResponse.json(
        { error: `totalCount must be between 1 and ${MAX_WALLETS_TOTAL}` },
        { status: 400 },
      );
    }
    if (offset + count > totalCount) {
      return NextResponse.json({ error: "offset + count must not exceed totalCount" }, { status: 400 });
    }
    if (
      distributorAddresses.length === 0 ||
      distributorAddresses.some((a) => !isAddress(a) || !ownerHasWallet(session.address, a))
    ) {
      return NextResponse.json({ error: "Select one or more valid distributor wallets first." }, { status: 400 });
    }

    if (splitMode === "equalTotal" && !deterministic && (totalCount > count || offset > 0)) {
      return NextResponse.json(
        {
          error:
            "Batched fixed-total + random per-wallet split is not supported. Enable deterministic (HD) for an even total split, or use at most 5,000 wallets in one go.",
        },
        { status: 400 },
      );
    }

    const addresses = deterministic
      ? deriveRecipientAddresses(seed, count, offset)
      : randomRecipientAddresses(count);

    let amounts: string[];

    if (splitMode === "randomRange") {
      const minAmount = String(body.minAmount ?? "").trim();
      const maxAmount = String(body.maxAmount ?? "").trim();
      if (!minAmount || !maxAmount) {
        return NextResponse.json({ error: "minAmount and maxAmount are required for random-range mode" }, { status: 400 });
      }
      amounts =
        mode === "native"
          ? randomAmountsInRangeNative(minAmount, maxAmount, count)
          : randomAmountsInRangeToken(minAmount, maxAmount, count, 18);
    } else {
      const totalAmount = String(body.totalAmount ?? "0").trim();
      if (!totalAmount || Number(totalAmount) <= 0) {
        return NextResponse.json({ error: "totalAmount must be a positive number" }, { status: 400 });
      }

      if (deterministic) {
        amounts =
          mode === "native"
            ? splitTotalNativeSlice(totalAmount, totalCount, offset, count)
            : splitTotalTokenSlice(totalAmount, totalCount, offset, count, 18);
      } else {
        amounts =
          mode === "native" ? splitTotalNativeRandom(totalAmount, count) : splitTotalTokenRandom(totalAmount, count, 18);
      }
    }

    const recipients = addresses.map((address, i) => ({
      id: String(offset + i + 1),
      address,
      amount: amounts[i] ?? "0",
      source: "backend-generated" as const,
    }));

    return NextResponse.json({ recipients });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Wallet generation failed" },
      { status: 400 },
    );
  }
}
