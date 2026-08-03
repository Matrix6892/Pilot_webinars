import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";

export const MAX_REDIRECTS = 3;
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_VISIBLE_TEXT_CHARS = 200_000;

const allowedContentTypes = new Set([
  "application/json",
  "application/xml",
  "text/html",
  "text/plain",
  "text/xml",
]);
const hostnameLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;

export class PublicWebFetchError extends Error {
  constructor(code) {
    super(code);
    this.name = "PublicWebFetchError";
    this.code = code;
  }
}

function fail(code) {
  throw new PublicWebFetchError(code);
}

function normalizedHostname(value) {
  return String(value ?? "")
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "")
    .toLocaleLowerCase();
}

function isForbiddenHostname(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "local" ||
    hostname === "internal" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  );
}

function isValidHostname(hostname) {
  if (!hostname || hostname.length > 253) return false;
  if (isIP(hostname)) return true;
  const labels = hostname.split(".");
  return labels.every((label) => label.length <= 63 && hostnameLabel.test(label));
}

function ipv4IsGlobalUnicast(address) {
  const [first, second, third, fourth] = address.split(".").map(Number);
  if ([first, second, third, fourth].some((part) => !Number.isInteger(part))) {
    return false;
  }
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && second >= 18 && second <= 19) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224 ||
    (first === 255 && second === 255 && third === 255 && fourth === 255)
  );
}

function ipv6IsGlobalUnicast(address) {
  const normalized = normalizedHostname(address);
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isIP(mapped) === 4 && ipv4IsGlobalUnicast(mapped);
  }
  if (normalized === "::" || normalized === "::1") return false;
  if (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff")
  ) {
    return false;
  }
  if (
    normalized.startsWith("2001:db8") ||
    normalized.startsWith("2001:2:") ||
    normalized.startsWith("2001:10:") ||
    normalized.startsWith("2002:") ||
    normalized.startsWith("3fff:")
  ) {
    return false;
  }
  const firstHextet = Number.parseInt(normalized.split(":")[0] || "", 16);
  return Number.isInteger(firstHextet) && firstHextet >= 0x2000 && firstHextet <= 0x3fff;
}

export function isGlobalUnicastAddress(address) {
  const normalized = normalizedHostname(address);
  if (isIP(normalized) === 4) return ipv4IsGlobalUnicast(normalized);
  if (isIP(normalized) === 6) return ipv6IsGlobalUnicast(normalized);
  return false;
}

export function validatePublicHttpsUrl(input) {
  if (typeof input !== "string" || !input.trim()) fail("invalid_url");

  let url;
  try {
    url = new URL(input);
  } catch {
    fail("invalid_url");
  }

  const hostname = normalizedHostname(url.hostname);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    !isValidHostname(hostname) ||
    isForbiddenHostname(hostname)
  ) {
    fail("unsafe_url");
  }
  if (isIP(hostname) && !isGlobalUnicastAddress(hostname)) {
    fail("unsafe_ip");
  }

  return {
    url,
    hostname,
    port: url.port || "443",
    ipLiteral: Boolean(isIP(hostname)),
  };
}

async function defaultResolveAll(hostname) {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function addressList(records) {
  const values = Array.isArray(records) ? records : [records];
  return [
    ...new Set(
      values
        .map((record) =>
          typeof record === "string" ? record : record?.address,
        )
        .map(normalizedHostname)
    ),
  ];
}

export async function resolvePublicTarget(input, resolveAll = defaultResolveAll) {
  const validated = validatePublicHttpsUrl(input);
  let records;
  if (!validated.ipLiteral) {
    try {
      records = await resolveAll(validated.hostname);
    } catch {
      fail("dns_failed");
    }
  }
  const addresses = validated.ipLiteral
    ? [validated.hostname]
    : addressList(records);

  if (!addresses.length || !addresses.every(isGlobalUnicastAddress)) {
    fail("unsafe_dns");
  }

  return {
    ...validated,
    addresses,
    pinnedAddress: addresses[0],
  };
}

function headerValue(headers, name) {
  const key = Object.keys(headers ?? {}).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  const value = key ? headers[key] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

function contentTypeOf(headers) {
  const value = headerValue(headers, "content-type");
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
}

function discardResponse(response) {
  try {
    response.destroy?.();
    response.resume?.();
  } catch {
    // Best effort socket cleanup.
  }
}

function requestOptionsFor(target, timeoutMs) {
  const hostHeader = target.url.host;
  const path = `${target.url.pathname || "/"}${target.url.search}`;
  return {
    protocol: "https:",
    hostname: target.hostname,
    port: target.port,
    method: "GET",
    path,
    servername: target.hostname,
    headers: {
      accept: "text/html,application/json,application/xml,text/plain;q=0.9,*/*;q=0.1",
      host: hostHeader,
      "user-agent": "KolerPublicWebFetch/1.0",
    },
    lookup(_hostname, options, callback) {
      const family = isIP(target.pinnedAddress);
      if (options?.all) {
        callback(null, [{ address: target.pinnedAddress, family }]);
        return;
      }
      callback(null, target.pinnedAddress, family);
    },
    timeout: timeoutMs,
  };
}

function readResponse(response, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      discardResponse(response);
      reject(error);
    };
    response.on("error", rejectOnce);
    const headers = response.headers ?? {};
    const contentType = contentTypeOf(headers);
    const contentLength = Number(headerValue(headers, "content-length"));
    if (
      !allowedContentTypes.has(contentType) ||
      (Number.isFinite(contentLength) && contentLength > maxBytes)
    ) {
      rejectOnce(new PublicWebFetchError("unsupported_response"));
      return;
    }
    response.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        rejectOnce(new PublicWebFetchError("response_too_large"));
        return;
      }
      chunks.push(buffer);
    });
    response.on("end", () => {
      if (settled) return;
      settled = true;
      resolve({
        contentType,
        body: Buffer.concat(chunks),
      });
    });
  });
}

export function visibleText(body, contentType, maxChars = MAX_VISIBLE_TEXT_CHARS) {
  let text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? "");
  if (contentType === "text/html") {
    text = text
      .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
      .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
      .replace(/<!--[\s\S]*?-->/gu, " ")
      .replace(/<[^>]*>/gu, " ");
  }
  return text.replace(/\s+/gu, " ").trim().slice(0, maxChars);
}

function isVerificationInterstitial(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized || normalized.length > 600) return false;
  return (
    /(?:please\s+wait|just\s+a\s+moment)[\s\S]{0,80}(?:verification|challenge|browser)/iu.test(
      normalized,
    ) ||
    /(?:checking\s+(?:your\s+)?browser|enable\s+javascript|javascript\s+required|captcha|access\s+denied|verify\s+you\s+are\s+human)/iu.test(
      normalized,
    )
  );
}

export function requestPinnedHttps(
  target,
  {
    requester = httpsRequest,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxBytes = MAX_RESPONSE_BYTES,
  } = {},
) {
  return new Promise((resolve, reject) => {
    let response;
    let request;
    let settled = false;
    const boundedTimeout = Math.min(
      MAX_REQUEST_TIMEOUT_MS,
      Math.max(1, Number(timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS),
    );
    const timer = setTimeout(() => {
      rejectOnce(new PublicWebFetchError("request_timeout"));
    }, boundedTimeout);
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        request?.destroy?.();
        response?.destroy?.();
      } catch {
        // Best effort socket cleanup.
      }
      reject(error);
    };
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    try {
      request = requester(
        requestOptionsFor(target, boundedTimeout),
        (nextResponse) => {
          response = nextResponse;
          const status = Number(nextResponse.statusCode);
          if (status >= 300 && status <= 399) {
            const location = headerValue(nextResponse.headers, "location");
            discardResponse(nextResponse);
            resolveOnce({ status, location });
            return;
          }
          if (status < 200 || status >= 300) {
            discardResponse(nextResponse);
            rejectOnce(new PublicWebFetchError("http_status"));
            return;
          }
          readResponse(nextResponse, maxBytes)
            .then((body) => resolveOnce({ status, ...body }))
            .catch(rejectOnce);
        },
      );
      request.on?.("error", rejectOnce);
      request.setTimeout?.(boundedTimeout, () => {
        rejectOnce(new PublicWebFetchError("request_timeout"));
      });
      request.end?.();
    } catch (error) {
      rejectOnce(error instanceof Error ? error : new PublicWebFetchError("request_failed"));
    }
  });
}

export async function fetchPublicWeb(
  input,
  {
    resolveAll = defaultResolveAll,
    requester = httpsRequest,
    maxRedirects = MAX_REDIRECTS,
    maxBytes = MAX_RESPONSE_BYTES,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxTextChars = MAX_VISIBLE_TEXT_CHARS,
  } = {},
) {
  const redirectsAllowed = Math.min(
    MAX_REDIRECTS,
    Math.max(0, Number(maxRedirects) || 0),
  );
  const boundedBytes = Math.min(
    MAX_RESPONSE_BYTES,
    Math.max(1, Number(maxBytes) || MAX_RESPONSE_BYTES),
  );
  const boundedTimeout = Math.min(
    MAX_REQUEST_TIMEOUT_MS,
    Math.max(1, Number(timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS),
  );
  const boundedChars = Math.min(
    MAX_VISIBLE_TEXT_CHARS,
    Math.max(1, Number(maxTextChars) || MAX_VISIBLE_TEXT_CHARS),
  );

  let current = input;
  let redirects = 0;
  while (true) {
    const target = await resolvePublicTarget(current, resolveAll);
    const response = await requestPinnedHttps(target, {
      requester,
      timeoutMs: boundedTimeout,
      maxBytes: boundedBytes,
    });
    if (response.status >= 300 && response.status <= 399) {
      if (redirects >= redirectsAllowed || typeof response.location !== "string") {
        fail("redirect_limit");
      }
      try {
        current = new URL(response.location, target.url).toString();
      } catch {
        fail("invalid_redirect");
      }
      redirects += 1;
      continue;
    }
    const text = visibleText(response.body, response.contentType, boundedChars);
    if (!text) fail("empty_response");
    if (isVerificationInterstitial(text)) fail("interstitial_response");
    return {
      url: target.url.toString(),
      contentType: response.contentType,
      redirects,
      text,
    };
  }
}
