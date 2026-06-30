import { createPublicClient, http, parseAbi, formatUnits } from "viem";

const ARC_RPC = "https://rpc.testnet.arc.network";
// audit 2026-05-22 Tema 4 — Arc'ta native gas USDC 18-decimal (CLAUDE.md "çift
// interface" tuzağı). ERC-20 interface 6-decimal; nativeCurrency.decimals burada
// 6 olarak yanlış yazılmış (10^12 kat sapma). 18 doğru.
const arcChain = { id: 5042002, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [ARC_RPC] } } } as const;
const USDC = "0x3600000000000000000000000000000000000000" as const;
const ERC8183 = "0x0747EEf0706327138c69792bF28Cd525089e4583" as const;

const client = createPublicClient({ chain: arcChain, transport: http(ARC_RPC) });

const JOB_ABI = parseAbi([
  "function getJob(uint256 jobId) view returns (uint256 id,address client,address provider,address evaluator,string description,uint256 budget,uint256 expiredAt,uint8 status,address hook)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const jobId = BigInt(process.argv[2] ?? "3436");
const wallet = (process.argv[3] ?? "0x29C2F998B325053F2e81532b5e3a44dac7A84978") as `0x${string}`;

const job = await client.readContract({ address: ERC8183, abi: JOB_ABI, functionName: "getJob", args: [jobId] });
const bal = await client.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] });

const states = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired", "Refunded"];
console.log(`Job #${jobId}:`);
console.log(`  id:          ${job[0]}`);
console.log(`  client:      ${job[1]}`);
console.log(`  provider:    ${job[2]}`);
console.log(`  evaluator:   ${job[3]}`);
console.log(`  description: ${job[4]}`);
console.log(`  budget:      ${formatUnits(job[5], 6)} USDC`);
console.log(`  expiredAt:   ${job[6]} (${new Date(Number(job[6]) * 1000).toISOString()})`);
console.log(`  status:      ${job[7]} (${states[Number(job[7])] ?? "unknown"})`);
console.log(`  hook:        ${job[8]}`);
console.log(`\nClient USDC balance: ${formatUnits(bal, 6)}`);
console.log(`Current timestamp: ${Math.floor(Date.now() / 1000)} (expired? ${Math.floor(Date.now() / 1000) > Number(job[5])})`);
