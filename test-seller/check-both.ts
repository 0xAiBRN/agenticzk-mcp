// audit 2026-05-22 MC-17 / Tema 6 — dotenv replaces brittle manual parser.
import "dotenv/config";
import { GatewayClient } from "@circle-fin/x402-batching/client";

async function bal(label: string, pk: string) {
  const g = new GatewayClient({ chain: "arcTestnet", privateKey: pk as `0x${string}` });
  const b = await g.getBalances();
  console.log(`${label}`);
  console.log(`  Addr:    ${g.address}`);
  console.log(`  Wallet:  ${b.wallet.formatted} USDC`);
  console.log(`  Gateway: ${b.gateway.formattedAvailable} USDC (raw ${b.gateway.available})`);
}

async function main() {
  await bal("BUYER", process.env.BUYER_PRIVATE_KEY!);
  await bal("SELLER", process.env.SELLER_PRIVATE_KEY!);
}
main().catch(e => { console.error(e); process.exit(1); });
