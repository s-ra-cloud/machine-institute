/** Classify without retaining provider messages, headers, or request bodies. */
export interface ResponseFailureMetadata {
  httpStatus?: number;
  mediaType?: string;
  jsonRead?: string;
}

export function safeResponseMetadata(value: any): ResponseFailureMetadata {
  const result: ResponseFailureMetadata = {};
  if (Number.isInteger(value?.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599)
    result.httpStatus = value.httpStatus;
  if (["json", "text", "html", "other", "missing"].includes(value?.mediaType))
    result.mediaType = value.mediaType;
  if (["not-read", "parsed", "invalid", "read-failed"].includes(value?.jsonRead))
    result.jsonRead = value.jsonRead;
  return result;
}

export function responseFailureSuffix(value: unknown): string {
  const metadata = safeResponseMetadata(value);
  const fields = Object.entries(metadata).map(([key, value]) => `${key}=${value}`);
  return fields.length ? ` [${fields.join(", ")}]` : "";
}

export function requestFailureCode(error: unknown): string | undefined {
  let current: any = error;
  const seen = new Set<unknown>();
  for (let depth = 0; current && depth < 6 && !seen.has(current); depth++) {
    seen.add(current);
    if (["SPENDING_CAP", "INVALID_COST"].includes(current.code)) return current.code;
    current = current.cause;
  }
  const value = error as any;
  if (["INVALID_PROVIDER_JSON", "PROVIDER_BODY_READ_FAILED"].includes(value?.code)) return value.code;
  if (["APIConnectionTimeoutError", "TimeoutError", "AbortError"].includes(value?.name)
    || ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "REQUEST_TIMEOUT"].includes(value?.code)) return "REQUEST_TIMEOUT";
  if (value?.name === "APIConnectionError"
    || ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "NETWORK_ERROR"].includes(value?.code)) return "NETWORK_ERROR";
  return undefined;
}

export function requestFailureMessage(code: string | undefined): string | undefined {
  if (code === "SPENDING_CAP") return "Local spending limit reached; request blocked before dispatch. No credential change is needed.";
  if (code === "INVALID_COST") return "Local cost verification failed; request blocked before dispatch.";
  if (code === "REQUEST_TIMEOUT") return "Model request timed out. This does not establish a credential problem.";
  if (code === "NETWORK_ERROR") return "Model connection failed. This does not establish a credential problem.";
  if (code === "INVALID_PROVIDER_JSON") return "Model provider returned invalid JSON.";
  if (code === "PROVIDER_BODY_READ_FAILED") return "Model response body could not be read.";
  return undefined;
}
