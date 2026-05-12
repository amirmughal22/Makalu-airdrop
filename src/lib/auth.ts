import { SignJWT, jwtVerify } from "jose";

function getSecretKey() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error("AUTH_SECRET must be set (min 16 characters). Add it in Plesk / .env");
  }
  return new TextEncoder().encode(s);
}

export async function signSessionToken(address: string): Promise<string> {
  const key = getSecretKey();
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(address.toLowerCase())
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(key);
}

export async function verifySessionToken(token: string): Promise<{ address: string } | null> {
  try {
    const key = getSecretKey();
    const { payload } = await jwtVerify(token, key);
    if (!payload.sub || typeof payload.sub !== "string") return null;
    return { address: payload.sub.toLowerCase() };
  } catch {
    return null;
  }
}
