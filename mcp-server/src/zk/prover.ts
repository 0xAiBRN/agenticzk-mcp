// Pluggable Groth16 prover.
//
// The default backend uses snarkjs (~20 s/proof on a 4-core VPS, ~1.6 GB RSS).
// B3.6.5 will add a rapidsnark backend (C++ native, ~3-4 s/proof) — both
// consume the same .zkey + .wasm + witness shape, so the surface stays:
//
//   prove(witness, opts) -> { proof, publicSignals }
//
// Callers (poker_shuffle_prove) pick a backend via config.zkProverBackend.

import { config } from "../config.js";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type Groth16Proof = {
  pi_a: string[];      // [a0, a1, "1"]
  pi_b: string[][];    // [[b00, b01], [b10, b11], ["1","0"]]
  pi_c: string[];      // [c0, c1, "1"]
  protocol: string;
  curve: string;
};

export type ProveResult = {
  proof: Groth16Proof;
  publicSignals: string[];
  /** Wall-clock breakdown so callers can log/diagnose. */
  timings: {
    witnessMs: number;
    proveMs: number;
    totalMs: number;
  };
};

export interface ShuffleProver {
  /** Generate witness + Groth16 proof for the bound shuffle circuit. */
  prove(witnessInput: object): Promise<ProveResult>;
  /** Identifier — appears in tool result metadata. */
  readonly backend: string;
}

// snarkjs is published with a "main" of build/main.cjs but its package.json
// "exports" field doesn't expose it as ESM cleanly when installed flat. We
// load via createRequire + the build/main.cjs path that always resolves.
const require = createRequire(import.meta.url);
let cachedSnarkjs: any | null = null;
function getSnarkjs(): any {
  if (cachedSnarkjs) return cachedSnarkjs;
  // Try the ESM-friendly default first; fall back to the cjs build path.
  try {
    cachedSnarkjs = require("snarkjs");
  } catch {
    cachedSnarkjs = require("snarkjs/build/main.cjs");
  }
  return cachedSnarkjs;
}

export class SnarkjsShuffleProver implements ShuffleProver {
  readonly backend = "snarkjs";
  constructor(private wasmPath: string, private zkeyPath: string) {}

  async prove(witnessInput: object): Promise<ProveResult> {
    const snarkjs = getSnarkjs();
    const t0 = performance.now();

    // snarkjs.groth16.fullProve does witness gen + prove in one shot,
    // skipping the intermediate .wtns file. Memory peaks are similar.
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      witnessInput,
      this.wasmPath,
      this.zkeyPath,
    );
    const t1 = performance.now();

    return {
      proof: proof as Groth16Proof,
      publicSignals: publicSignals as string[],
      timings: {
        // fullProve doesn't break out witness vs prove; report combined total
        // under proveMs to keep the shape stable across backends.
        witnessMs: 0,
        proveMs: t1 - t0,
        totalMs: t1 - t0,
      },
    };
  }
}

// rapidsnark binary is invoked as:
//   prover <zkey> <wtns> <proof.json> <public.json>
// Witness is generated separately via snarkjs.wtns.calculate (writes the .wtns
// file). Same zkey works for both backends; only the prove step is native.
export class RapidsnarkShuffleProver implements ShuffleProver {
  readonly backend = "rapidsnark";
  constructor(
    private wasmPath: string,
    private zkeyPath: string,
    private binaryPath: string,
  ) {}

  async prove(witnessInput: object): Promise<ProveResult> {
    const snarkjs = getSnarkjs();
    const dir = await mkdtemp(path.join(tmpdir(), "rapidsnark-"));
    const wtnsPath = path.join(dir, "witness.wtns");
    const proofPath = path.join(dir, "proof.json");
    const publicPath = path.join(dir, "public.json");

    try {
      const t0 = performance.now();
      await snarkjs.wtns.calculate(witnessInput, this.wasmPath, wtnsPath);
      const t1 = performance.now();
      await execRapidsnark(this.binaryPath, this.zkeyPath, wtnsPath, proofPath, publicPath);
      const t2 = performance.now();

      const proof = JSON.parse(await readFile(proofPath, "utf-8"));
      const publicSignals = JSON.parse(await readFile(publicPath, "utf-8"));

      return {
        proof: proof as Groth16Proof,
        publicSignals: publicSignals as string[],
        timings: {
          witnessMs: t1 - t0,
          proveMs: t2 - t1,
          totalMs: t2 - t0,
        },
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function execRapidsnark(
  bin: string,
  zkey: string,
  wtns: string,
  proof: string,
  pub: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [zkey, wtns, proof, pub], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Capture stderr for diagnostics; rapidsnark prints proof timing to stdout
    // which we don't need (we measure wall-clock from JS side anyway).
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`rapidsnark exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * ZK Shuffle Gas milestone (2026-05-21) — pick the prover for one shuffle
 * round. The shuffle was split into three commitment-public circuits selected
 * by round index; each is a distinct (wasm, zkey) pair but the same witness
 * shape and backend. `poker_shuffle_prove` classifies the round from
 * DealSystem.shuffleRound + handRoster and calls the matching factory.
 */
export type ShuffleRole = "first" | "mid" | "last";

export function makeShuffleProver(role: ShuffleRole): ShuffleProver {
  switch (role) {
    case "first":
      return makeProver(config.zkShuffleFirstWasm, config.zkShuffleFirstZkey);
    case "mid":
      return makeProver(config.zkShuffleMidWasm, config.zkShuffleMidZkey);
    case "last":
      return makeProver(config.zkShuffleLastWasm, config.zkShuffleLastZkey);
    default: {
      const _exhaustive: never = role;
      throw new Error(`Unknown shuffle role: ${_exhaustive as string}`);
    }
  }
}

/**
 * Build a prover for the `deck_commit` circuit — proves only
 * `out == DeckCommit(deck)` (no shuffle relation). Used by
 * poker_report_shuffle_da_fault to adjudicate a data-availability fault.
 */
export function makeDeckCommitProver(): ShuffleProver {
  return makeProver(config.zkDeckCommitWasm, config.zkDeckCommitZkey);
}

/**
 * Build a Groth16 prover for the elgamal_decrypt circuit (B3.7.C). Same
 * backends, same calldata shape — just a different (wasm, zkey) pair.
 */
export function makeDecryptProver(): ShuffleProver {
  return makeProver(config.zkDecryptWasm, config.zkDecryptZkey);
}

/** Pick the configured backend for an arbitrary (wasm, zkey) circuit. */
export function makeProver(wasmPath: string, zkeyPath: string): ShuffleProver {
  switch (config.zkProverBackend) {
    case "snarkjs":
      return new SnarkjsShuffleProver(wasmPath, zkeyPath);
    case "rapidsnark":
      return new RapidsnarkShuffleProver(wasmPath, zkeyPath, config.zkRapidsnarkBin);
    default:
      throw new Error(`Unknown ZK_PROVER_BACKEND: ${config.zkProverBackend}`);
  }
}

/**
 * Convert a snarkjs Groth16 proof to the calldata-shaped tuple the Solidity
 * verifier expects: pA[2], pB[2][2], pC[2]. snarkjs encodes pi_b in the
 * "natural" Fp2 order (Fp2 = a + b*u, stored as [a, b]) but the verifier
 * expects them flipped (b first, a second) for the on-chain pairing layout.
 *
 * The same row-flip applies to publicSignals trim (snarkjs adds a trailing "1"
 * at index 0, callers strip it before passing to the contract).
 */
export function proofToSolidityCalldata(p: Groth16Proof): {
  pA: [bigint, bigint];
  pB: [[bigint, bigint], [bigint, bigint]];
  pC: [bigint, bigint];
} {
  const big = (s: string) => BigInt(s);
  return {
    pA: [big(p.pi_a[0]), big(p.pi_a[1])],
    // Note the inner-pair flip: contract expects [b1, b0] not [b0, b1].
    pB: [
      [big(p.pi_b[0][1]), big(p.pi_b[0][0])],
      [big(p.pi_b[1][1]), big(p.pi_b[1][0])],
    ],
    pC: [big(p.pi_c[0]), big(p.pi_c[1])],
  };
}
