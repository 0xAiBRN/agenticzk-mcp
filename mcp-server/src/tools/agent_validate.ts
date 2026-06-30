import { encodeFunctionData } from "viem";
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { ValidationRegistryAbi, readContractWithRetry } from "../chains.js";
import { okResult, errorResult, err } from "../errors.js";
import { keccak256, stringToHex } from "viem";
import { validateAddress, validateBytes32 } from "../validate.js";

export async function agentValidateHandler(args: {
  action: string;
  owner?: string;
  validator?: string;
  agentId?: string;
  requestURI?: string;
  requestHash?: string;
  response?: number;
  responseURI?: string;
  tag?: string;
}) {
  const { action } = args;

  if (action === "request") {
    const { agentId, requestURI } = args;
    if (!args.owner || !args.validator || !agentId || !requestURI) {
      return errorResult(err("E_MISSING_PARAMS", "request action requires: owner, validator, agentId, requestURI"));
    }
    // audit 2026-05-22 MC-09 — owner + validator runtime adres doğrulaması.
    const owner = validateAddress(args.owner);
    if (!owner) {
      return errorResult(err("E_INVALID_ADDRESS", "owner must be a valid 0x-prefixed 20-byte address"));
    }
    const validator = validateAddress(args.validator);
    if (!validator) {
      return errorResult(err("E_INVALID_ADDRESS", "validator must be a valid 0x-prefixed 20-byte address"));
    }
    // audit 2026-05-22 MC-10 — BigInt(agentId) try/catch.
    let agentIdBig: bigint;
    try {
      agentIdBig = BigInt(agentId);
    } catch (e) {
      return errorResult(err("E_INVALID_AGENT_ID", `agentId must be numeric: ${(e as Error).message}`));
    }

    // audit 2026-05-22 K#3 — Date.now() (ms hassasiyetli) tahmin edilebilir;
    // requestHash'i CSPRNG nonce ile türet.
    const requestHash = keccak256(
      stringToHex(`${agentId}-${requestURI}-${randomBytes(32).toString("hex")}`),
    );

    const data = encodeFunctionData({
      abi: ValidationRegistryAbi,
      functionName: "validationRequest",
      args: [
        validator,
        agentIdBig,
        requestURI,
        requestHash,
      ],
    });

    return okResult({
      unsignedTx: {
        to: config.validationRegistry,
        data,
        value: "0",
        chainId: config.arcChainId,
      },
      owner,
      requestHash,
      note: "Request validation from validator.",
    });
  }

  if (action === "respond") {
    const { response, responseURI, tag } = args;
    if (!args.validator || !args.requestHash) {
      return errorResult(err("E_MISSING_PARAMS", "respond action requires: validator, requestHash"));
    }
    // audit 2026-05-22 MC-09 — validator adres + requestHash bytes32 runtime guard.
    const validator = validateAddress(args.validator);
    if (!validator) {
      return errorResult(err("E_INVALID_ADDRESS", "validator must be a valid 0x-prefixed 20-byte address"));
    }
    const requestHash = validateBytes32(args.requestHash);
    if (!requestHash) {
      return errorResult(err("E_INVALID_REQUEST_HASH", "requestHash must be a 0x-prefixed 32-byte hex string"));
    }
    // audit 2026-05-22 K#3 — `response` ZORUNLU. Eski `response ?? 100` default'u
    // bir authz bypass'tı: çağıran `response`'u atlayarak bilinen bir requestHash'e
    // "passed" (100) yanıtlı imzasız tx üretebiliyordu → sahte validation
    // sertifikası → ERC-8004 reputation manipülasyonu. Artık geçerli/başarısız
    // kararı açıkça belirtilmek zorunda.
    if (response === undefined || response === null) {
      return errorResult(
        err(
          "E_MISSING_PARAMS",
          "respond action requires an explicit 'response' (100 = passed, 0 = failed) — no default",
        ),
      );
    }
    const responseCode = response;
    // audit 2026-05-22 K#3 — responseHash de CSPRNG nonce ile (Date.now() değil).
    const responseHash = keccak256(
      stringToHex(`${requestHash}-${responseCode}-${randomBytes(32).toString("hex")}`),
    );

    const data = encodeFunctionData({
      abi: ValidationRegistryAbi,
      functionName: "validationResponse",
      args: [
        requestHash,
        responseCode,
        responseURI ?? "",
        responseHash,
        tag ?? "validation",
      ],
    });

    return okResult({
      unsignedTx: {
        to: config.validationRegistry,
        data,
        value: "0",
        chainId: config.arcChainId,
      },
      validator,
      requestHash,
      responseCode,
      note: "Validator response; 100 = passed, 0 = failed.",
    });
  }

  if (action === "status") {
    if (!args.requestHash) {
      return errorResult(err("E_MISSING_PARAMS", "status action requires: requestHash"));
    }
    // audit 2026-05-22 MC-09 — requestHash bytes32 runtime guard.
    const requestHash = validateBytes32(args.requestHash);
    if (!requestHash) {
      return errorResult(err("E_INVALID_REQUEST_HASH", "requestHash must be a 0x-prefixed 32-byte hex string"));
    }

    // audit 2026-05-22 K#3 + MC-11 — status, bu tool'un tek gerçek RPC çağrısı.
    // readContractWithRetry transient blip'leri yutar (chains.ts'in
    // arcClient.readContract'ı zaten monkey-patched ama explicit kullanım niyeti
    // okunaklı kılar); üst-düzey try/catch MCP process crash'i önler.
    let status: unknown;
    try {
      status = await readContractWithRetry({
        address: config.validationRegistry,
        abi: ValidationRegistryAbi,
        functionName: "getValidationStatus",
        args: [requestHash],
      });
    } catch (e) {
      return errorResult(
        err("E_VALIDATION_READ", `getValidationStatus read failed: ${(e as Error).message}`),
      );
    }

    return okResult({
      requestHash,
      status: Number(status),
      statusLabel: status === 100 ? "passed" : status === 0 ? "pending_or_failed" : `unknown(${status})`,
    });
  }

  return errorResult(err("E_INVALID_ACTION", "Action must be 'request', 'respond', or 'status'"));
}
