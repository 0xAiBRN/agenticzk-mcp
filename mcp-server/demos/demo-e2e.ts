/**
 * Arc Agent Toolkit — E2E Demo
 *
 * Runs the full agent economy flow on Arc Testnet with real transactions:
 * 1. Check balance
 * 2. Register an AI agent (ERC-8004)
 * 3. Create a job (ERC-8183)
 * 4. Set budget
 * 5. Fund escrow
 * 6. Submit deliverable
 * 7. Complete job (release payment)
 * 8. Send USDC
 * 9. Check final balance
 */

import { createPublicClient, createWalletClient, http, formatUnits, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import "dotenv/config";

const ARC_RPC = "https://rpc.testnet.arc.network";
const CHAIN_ID = 5042002;

// audit 2026-05-22 Tema 4 — Arc'ta native gas USDC 18-decimal (CLAUDE.md
// "çift interface" tuzağı). Burada decimals=6 yazılmıştı → native balance
// formatlamasını 10^12 kat bozar. 18 doğru.
const arcChain = {
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC] } },
} as const;

// Contracts
const USDC = "0x3600000000000000000000000000000000000000" as const;
const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const ERC8183 = "0x0747EEf0706327138c69792bF28Cd525089e4583" as const;

// Load deployer key
const pk = process.env.DEPLOYER_PK;
if (!pk) {
  console.error("Set DEPLOYER_PK in env (or create .env file)");
  process.exit(1);
}

const account = privateKeyToAccount(pk as `0x${string}`);
const publicClient = createPublicClient({ chain: arcChain, transport: http(ARC_RPC) });
const walletClient = createWalletClient({ account, chain: arcChain, transport: http(ARC_RPC) });

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
]);

const IDENTITY_ABI = parseAbi([
  "function register(string metadataURI)",
]);

const JOB_ABI = parseAbi([
  "function createJob(address provider,address evaluator,uint256 expiredAt,string description,address hook)",
  "function setBudget(uint256 jobId,uint256 amount,bytes optParams)",
  "function fund(uint256 jobId,bytes optParams)",
  "function submit(uint256 jobId,bytes32 deliverable,bytes optParams)",
  "function complete(uint256 jobId,bytes32 reason,bytes optParams)",
  "function getJob(uint256 jobId) view returns (address,address,address,uint8,uint256,uint256,string)",
  "event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 expiredAt,address hook)",
]);

function log(step: string, msg: string) {
  console.log(`\n[${step}] ${msg}`);
}

async function waitTx(hash: `0x${string}`, label: string) {
  console.log(`  tx: ${hash}`);
  console.log(`  explorer: https://testnet.arcscan.app/tx/${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  status: ${receipt.status} (block ${receipt.blockNumber})`);
  if (receipt.status !== "success") throw new Error(`${label} failed!`);
  return receipt;
}

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  Arc Agent Toolkit — E2E Demo");
  console.log("  Wallet:", account.address);
  console.log("═══════════════════════════════════════════");

  // ── Step 1: Check balance ──
  log("1/8", "Checking USDC balance...");
  const balBefore = await publicClient.readContract({
    address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address],
  });
  console.log(`  USDC: ${formatUnits(balBefore, 6)}`);
  if (balBefore < 500_000n) { // < 0.5 USDC
    console.error("  Not enough USDC. Get test tokens from https://faucet.circle.com");
    process.exit(1);
  }

  // ── Step 2: Register agent ──
  log("2/8", "Registering AI agent (ERC-8004)...");
  const metadataURI = `https://arcent.dev/agent/${Date.now()}.json`;
  const regHash = await walletClient.writeContract({
    address: IDENTITY_REGISTRY, abi: IDENTITY_ABI,
    functionName: "register", args: [metadataURI],
  });
  const regReceipt = await waitTx(regHash, "agent_register");
  console.log(`  Agent registered! Metadata: ${metadataURI}`);

  // ── Step 3: Create job ──
  log("3/8", "Creating agentic job (ERC-8183)...");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1h from now
  const jobHash = await walletClient.writeContract({
    address: ERC8183, abi: JOB_ABI,
    functionName: "createJob",
    args: [
      account.address,  // provider = self (demo)
      account.address,  // evaluator = self (demo)
      deadline,
      "Arc Agent Toolkit E2E demo — analyze test data",
      "0x0000000000000000000000000000000000000000",
    ],
  });
  const jobReceipt = await waitTx(jobHash, "job_create");

  // Extract jobId from logs
  const jobEvent = jobReceipt.logs.find(l => l.address.toLowerCase() === ERC8183.toLowerCase());
  const jobId = jobEvent ? BigInt(jobEvent.topics[1]!) : 0n;
  console.log(`  Job ID: ${jobId}`);

  // ── Step 4: Set budget ──
  log("4/8", "Setting job budget: 0.10 USDC...");
  const budget = 100_000n; // 0.10 USDC (6 decimals)
  const budgetHash = await walletClient.writeContract({
    address: ERC8183, abi: JOB_ABI,
    functionName: "setBudget", args: [jobId, budget, "0x"],
  });
  await waitTx(budgetHash, "job_set_budget");

  // ── Step 5: Approve + Fund escrow ──
  log("5/8", "Approving USDC + funding escrow...");
  const approveHash = await walletClient.writeContract({
    address: USDC, abi: ERC20_ABI,
    functionName: "approve", args: [ERC8183, budget],
  });
  await waitTx(approveHash, "usdc_approve");

  const fundHash = await walletClient.writeContract({
    address: ERC8183, abi: JOB_ABI,
    functionName: "fund", args: [jobId, "0x"],
  });
  await waitTx(fundHash, "job_fund");
  console.log(`  Escrowed: 0.10 USDC`);

  // ── Step 6: Submit deliverable ──
  log("6/8", "Submitting deliverable...");
  const { keccak256, toHex } = await import("viem");
  const deliverable = keccak256(toHex("arc-agent-toolkit-e2e-demo-deliverable"));
  const submitHash = await walletClient.writeContract({
    address: ERC8183, abi: JOB_ABI,
    functionName: "submit", args: [jobId, deliverable, "0x"],
  });
  await waitTx(submitHash, "job_submit");

  // ── Step 7: Complete job ──
  log("7/8", "Completing job — releasing payment...");
  const reason = keccak256(toHex("approved-e2e-demo"));
  const completeHash = await walletClient.writeContract({
    address: ERC8183, abi: JOB_ABI,
    functionName: "complete", args: [jobId, reason, "0x"],
  });
  await waitTx(completeHash, "job_complete");
  console.log(`  Payment released to provider!`);

  // ── Step 8: Check final balance ──
  log("8/8", "Final balance check...");
  const balAfter = await publicClient.readContract({
    address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address],
  });
  console.log(`  USDC before: ${formatUnits(balBefore, 6)}`);
  console.log(`  USDC after:  ${formatUnits(balAfter, 6)}`);
  console.log(`  Gas spent:   ${formatUnits(balBefore - balAfter, 6)} USDC`);

  // ── Summary ──
  console.log("\n═══════════════════════════════════════════");
  console.log("  E2E Demo Complete!");
  console.log(`  Agent registered: ✓`);
  console.log(`  Job created (#${jobId}): ✓`);
  console.log(`  Escrow funded (0.10 USDC): ✓`);
  console.log(`  Deliverable submitted: ✓`);
  console.log(`  Payment released: ✓`);
  console.log(`  Gas cost: ${formatUnits(balBefore - balAfter, 6)} USDC`);
  console.log("═══════════════════════════════════════════");
}

main().catch(e => {
  console.error("\nDemo failed:", e.message);
  process.exit(1);
});
