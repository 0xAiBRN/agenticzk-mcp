// audit 2026-05-22 MC-20 / Tema 8 — chains.ts 492 satır 4 sorumluluk
// god-module idi → transport / rpc-utils / base-abis 3 modüle bölündü.
// Bu dosya BARREL re-export: 24 tool/import dosyasında "../chains.js" path'i
// değişmez, geriye uyum korunur. Yeni kod yazılırken doğrudan alt modüllerden
// import etmek tercih edilebilir; ama bu barrel kalıcı (drop-in compat).
//
// Side-effect: rpc-utils.ts yüklendiğinde arcClient.readContract'i exp-backoff
// retry wrapper'ı ile monkey-patch'liyor. Bu barrel her iki modülü de
// re-export ettiği için side-effect garanti edilir (sıra: transport → rpc-utils).
export * from "./transport.js";
export * from "./rpc-utils.js";
export * from "./base-abis.js";
