// audit 2026-05-22 MC-17 / Tema 6 — manuel regex `.env` parser KEY="val" /
// trailing \r / # yorum desteklemiyordu → PK sessiz yanlış değer ile geçebiliyor.
// `dotenv` paketi cwd-relative `.env`'i import-time okur (mevcut path.resolve
// davranışıyla eş anlamlı), doğru parse eder.
import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";

const SELLER_ADDRESS = process.env.SELLER_ADDRESS;
if (!SELLER_ADDRESS) {
  console.error("Missing SELLER_ADDRESS. Run: npm run generate-wallets");
  process.exit(1);
}

const ARC_TESTNET_CAIP2 = "eip155:5042002";
const PORT = Number(process.env.PORT ?? 3000);

const endpoints = [
  { path: "/api/premium/quote", price: "0.001", handler: () => ({ quote: "Alone we can do so little; together we can do so much. — Helen Keller" }) },
  { path: "/api/premium/dataset", price: "0.01", handler: () => ({
    dataset: { series: "arc_tps_24h", points: [1823, 1901, 2100, 2275, 2490, 2612, 2754] },
  }) },
  { path: "/api/premium/compute", price: "0.0003", handler: (req: Request) => ({
    input: req.body?.text ?? "",
    analysis: { length: (req.body?.text ?? "").length, words: (req.body?.text ?? "").split(/\s+/).filter(Boolean).length },
  }) },
  { path: "/api/premium/agent-task", price: "0.03", handler: () => ({
    task: { step: 1, clue: "Begin at the block labeled 0x4CEF52 — the chain knows its own id." },
  }) },
];

const app = express();
app.use(express.json());

let callCount = 0;
let totalCollected = 0;

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

const gateway = createGatewayMiddleware({
  sellerAddress: SELLER_ADDRESS,
  networks: ARC_TESTNET_CAIP2,
  description: "Arcent Test Seller — paywalled premium endpoints",
});

for (const ep of endpoints) {
  const method = ep.path.includes("compute") ? "post" : "get";
  const handler = (req: Request, res: Response) => {
    callCount++;
    totalCollected += parseFloat(ep.price);
    console.log(`  ✓ Paid ${ep.price} USDC — total calls: ${callCount}, collected: ${totalCollected.toFixed(6)} USDC`);
    res.json(ep.handler(req));
  };
  (app as unknown as Record<string, (...a: unknown[]) => void>)[method](ep.path, gateway.require(`$${ep.price}`), handler);
}

app.get("/stats", (_req: Request, res: Response) => {
  res.json({ callCount, totalCollectedUsdc: totalCollected.toFixed(6), seller: SELLER_ADDRESS, network: ARC_TESTNET_CAIP2 });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Error:", err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`\nArcent Test Seller — running on http://localhost:${PORT}`);
  console.log(`Seller address: ${SELLER_ADDRESS}`);
  console.log(`Network: ${ARC_TESTNET_CAIP2}`);
  console.log(`\nPaywalled endpoints:`);
  for (const ep of endpoints) {
    console.log(`  ${ep.path.includes("compute") ? "POST" : "GET "} ${ep.path.padEnd(30)} $${ep.price} USDC`);
  }
  console.log(`  GET  /stats                          (no payment, shows counters)\n`);
  console.log(`Ready. Make your first nano_pay call.\n`);
});
