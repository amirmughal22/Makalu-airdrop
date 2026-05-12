import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { CHAIN_ID_DECIMAL } from "@/lib/chain";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { address?: string; chainId?: number };
    const address = typeof body.address === "string" ? body.address : "";
    const chainId = Number(body.chainId ?? CHAIN_ID_DECIMAL);
    if (!isAddress(address) || !Number.isFinite(chainId)) {
      return NextResponse.json({ error: "Invalid address or chainId" }, { status: 400 });
    }
    const nonce = randomBytes(16).toString("hex");
    const message = [
      "Makalu Airdrop — sign to verify your wallet.",
      "",
      `Address: ${getAddress(address)}`,
      `Chain ID: ${chainId}`,
      `Nonce: ${nonce}`,
    ].join("\n");
    return NextResponse.json({ message, nonce });
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
}
