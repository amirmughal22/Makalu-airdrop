import { getBytes, HDNodeWallet, keccak256, toUtf8Bytes, Wallet } from "ethers";

/** One fresh EOA address per call (crypto-secure random private key). */
export function randomRecipientAddresses(count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Wallet.createRandom().address);
  }
  return out;
}

/** Deterministic recipient addresses from seed (HD path m/44'/60'/0'/(startIndex..startIndex+count-1)). */
export function deriveRecipientAddresses(seed: string, count: number, startIndex = 0): string[] {
  const seedMaterial = getBytes(keccak256(toUtf8Bytes(`makalu-airdrop:${seed}`)));
  const root = HDNodeWallet.fromSeed(seedMaterial);
  const addresses: string[] = [];
  for (let i = 0; i < count; i++) {
    const child = root.derivePath(`m/44'/60'/0'/0/${startIndex + i}`);
    addresses.push(child.address);
  }
  return addresses;
}
