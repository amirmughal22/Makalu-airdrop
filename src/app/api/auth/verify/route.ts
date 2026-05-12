import { NextResponse } from "next/server";
import { getAddress, isAddress, verifyMessage } from "viem";
import { signSessionToken } from "@/lib/auth";
import { CHAIN_ID_DECIMAL } from "@/lib/chain";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      address?: string;
      chainId?: number;
      message?: string;
      nonce?: string;
      signature?: string;
    };
    const address = typeof body.address === "string" ? body.address : "";
    const message = typeof body.message === "string" ? body.message : "";
    const signature = typeof body.signature === "string" ? body.signature : "";
    const chainId = Number(body.chainId ?? CHAIN_ID_DECIMAL);

    if (!isAddress(address) || !message || !signature) {
      return NextResponse.json({ error: "Missing address, message, or signature" }, { status: 400 });
    }
    if (!Number.isFinite(chainId)) {
      return NextResponse.json({ error: "Invalid chainId" }, { status: 400 });
    }

    let valid = false;
    try {
      valid = await verifyMessage({
        address: getAddress(address),
        message,
        signature: signature as `0x${string}`,
      });
    } catch {
      valid = false;
    }
    if (!valid) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const token = await signSessionToken(getAddress(address));
    return NextResponse.json({ address: getAddress(address), token });
  } catch (e) {
    if (e instanceof Error && e.message.includes("AUTH_SECRET")) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
