// audit 2026-05-22 MC-17 / Tema 6 — dotenv replaces brittle manual parser.
import "dotenv/config";
import { createPublicClient, createWalletClient, http, formatUnits, parseAbi, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";

const pk = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined;
if (!pk) {
  console.error("Missing BUYER_PRIVATE_KEY");
  process.exit(1);
}

const ARC_RPC = "https://rpc.testnet.arc.network";
const arcChain = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: [ARC_RPC] } },
} as const;

const USDC = "0x3600000000000000000000000000000000000000" as const;
const ERC8183 = "0x0747EEf0706327138c69792bF28Cd525089e4583" as const;

const account = privateKeyToAccount(pk);
const publicClient = createPublicClient({ chain: arcChain, transport: http(ARC_RPC) });
const walletClient = createWalletClient({ account, chain: arcChain, transport: http(ARC_RPC) });

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

const JOB_ABI = parseAbi([
  "function createJob(address provider,address evaluator,uint256 expiredAt,string description,address hook)",
  "function setBudget(uint256 jobId,uint256 amount,bytes optParams)",
  "function fund(uint256 jobId,bytes optParams)",
  "function submit(uint256 jobId,bytes32 deliverable,bytes optParams)",
  "function reject(uint256 jobId,bytes32 reason,bytes optParams)",
  "function claimRefund(uint256 jobId)",
  "function getJob(uint256 jobId) view returns (address,address,address,uint8,uint256,uint256,string)",
  "event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 expiredAt,address hook)",
]);

async function waitTx(hash: `0x${string}`, label: string) {
  console.log(`  tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  status: ${receipt.status} (block ${receipt.blockNumber})`);
  if (receipt.status !== "success") throw new Error(`${label} failed`);
  return receipt;
}

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  ERC-8183 Safety Test — reject + claimRefund");
  console.log("  Wallet:", account.address);
  console.log("═══════════════════════════════════════════");

  const balBefore = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
  console.log(`\n[1/7] USDC balance: ${formatUnits(balBefore, 6)}`);
  if (balBefore < 200_000n) throw new Error("Need at least 0.2 USDC for test");

  console.log(`\n[2/7] Creating job...`);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const jobHash = await walletClient.writeContract({
    address: ERC8183, abi: JOB_ABI, functionName: "createJob",
    args: [account.address, account.address, deadline, "Arcent safety test — will be rejected intentionally", "0x0000000000000000000000000000000000000000"],
  });
  const jobReceipt = await waitTx(jobHash, "createJob");
  const jobEvent = jobReceipt.logs.find(l => l.address.toLowerCase() === ERC8183.toLowerCase());
  const jobId = jobEvent ? BigInt(jobEvent.topics[1]!) : 0n;
  console.log(`  Job ID: ${jobId}`);

  console.log(`\n[3/7] setBudget 0.10 USDC...`);
  const budget = 100_000n;
  const budgetHash = await walletClient.writeContract({
    address: ERC8183, abi: JOB_ABI, functionName: "setBudget", args: [jobId, budget, "0x"],
  });
  await waitTx(budgetHash, "setBudget");

  console.log(`\n[4/7] approve + fund escrow...`);
  const approveHash = await walletClient.writeContract({
    address: USDC, abi: ERC20_ABI, functionName: "approve", args: [ERC8183, budget],
  });
  await waitTx(approveHash, "approve");
  const fundHash = await walletClient.writeContract({
    address: ERC8183, abi: JOB_ABI, functionName: "fund", args: [jobId, "0x"],
  });
  await waitTx(fundHash, "fund");
  const balAfterFund = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
  console.log(`  USDC after fund: ${formatUnits(balAfterFund, 6)} (escrow holds 0.10)`);

  console.log(`\n[5/7] submit deliverable (bad quality)...`);
  const deliverable = keccak256(toHex("arcent-safety-test-bad-deliverable"));
  const submitHash = await walletClient.writeContract({
    address: ERC8183, abi: JOB_ABI, functionName: "submit", args: [jobId, deliverable, "0x"],
  });
  await waitTx(submitHash, "submit");

  console.log(`\n[6/7] reject with reason...`);
  const reason = keccak256(toHex("rejected: deliverable does not meet criteria"));
  const rejectHash = await walletClient.writeContract({
    address: ERC8183, abi: JOB_ABI, functionName: "reject", args: [jobId, reason, "0x"],
  });
  await waitTx(rejectHash, "reject");

  console.log(`\n[7/7] claimRefund — escrow back to client...`);
  const refundHash = await walletClient.writeContract({
    address: ERC8183, abi: JOB_ABI, functionName: "claimRefund", args: [jobId],
  });
  await waitTx(refundHash, "claimRefund");

  const balFinal = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
  const escrowReturned = balFinal - balAfterFund;

  console.log(`\n═══════════════════════════════════════════`);
  console.log(`  Safety Test Complete`);
  console.log(`  USDC before:        ${formatUnits(balBefore, 6)}`);
  console.log(`  USDC after fund:    ${formatUnits(balAfterFund, 6)}  (-0.10 escrow)`);
  console.log(`  USDC after refund:  ${formatUnits(balFinal, 6)}  (+${formatUnits(escrowReturned, 6)} recovered)`);
  console.log(`  Net gas cost:       ${formatUnits(balBefore - balFinal, 6)} USDC`);
  console.log(`  Escrow recovered:   ${escrowReturned === 100_000n ? "YES — full 0.10 USDC" : "PARTIAL — " + formatUnits(escrowReturned, 6)}`);
  console.log(`═══════════════════════════════════════════`);

  const artifact = {
    title: "Arcent ERC-8183 Safety E2E — reject + claimRefund",
    network: "arcTestnet",
    chainId: 5042002,
    wallet: account.address,
    jobId: jobId.toString(),
    budget: "0.10",
    balanceBefore: formatUnits(balBefore, 6),
    balanceAfterFund: formatUnits(balAfterFund, 6),
    balanceFinal: formatUnits(balFinal, 6),
    escrowRecovered: formatUnits(escrowReturned, 6),
    gasCost: formatUnits(balBefore - balFinal, 6),
    txHashes: {
      createJob: jobHash,
      setBudget: budgetHash,
      approve: approveHash,
      fund: fundHash,
      submit: submitHash,
      reject: rejectHash,
      claimRefund: refundHash,
    },
    timestamp: new Date().toISOString(),
  };

  const outPath = path.resolve("../demos/safety-e2e.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(`\nArtifact written: ${outPath}\n`);
}

main().catch(e => {
  console.error("\nTest failed:", e.message);
  process.exit(1);
});
