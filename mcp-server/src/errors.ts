export interface McpError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export function err(code: string, message: string, details?: Record<string, unknown>): McpError {
  return { code, message, ...(details ? { details } : {}) };
}

export function errorResult(e: McpError) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(e) }],
    isError: true,
  };
}

export function okResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, bigintReplacer) }],
  };
}

function bigintReplacer(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v;
}
