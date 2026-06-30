// audit 2026-05-22 Tema 1 / MC-09 — `as `0x${string}`` cast runtime'da
// hiçbir şey doğrulamaz ("0xGGGG..." veya yanlış uzunluktaki adres tipe
// uyar ama on-chain'e gidince revert eder + gas yakar). Tüm tool'lar bu
// helper'ı kullansın; tek noktada çözüm.
import { isAddress, getAddress } from "viem";

/**
 * Runtime'da geçerli 0x-prefixed 20-byte adres doğrular ve checksum'lı
 * (EIP-55) hale getirir. Geçersizse `null` döner — caller `errorResult`
 * + `err("E_INVALID_ADDRESS", ...)` ile cevaplamalı.
 */
export function validateAddress(input: unknown): `0x${string}` | null {
  if (typeof input !== "string") return null;
  if (!isAddress(input)) return null;
  return getAddress(input) as `0x${string}`;
}

/**
 * 32-byte hex doğrular (tableId, tournamentId, requestHash, txHash gibi).
 * `0x` + tam 64 hex karakteri zorunlu. Geçersizse `null`.
 */
export function validateBytes32(input: unknown): `0x${string}` | null {
  if (typeof input !== "string") return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(input)) return null;
  return input as `0x${string}`;
}
