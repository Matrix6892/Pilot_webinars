import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  fetchPublicWeb,
  isGlobalUnicastAddress,
} from "../lib/public-web-fetch.mjs";

function fakeRequester(responses, calls) {
  return (options, callback) => {
    calls.push(options);
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = () => {};
    request.end = () => {
      queueMicrotask(() => {
        const response = responses.shift();
        callback(response);
        queueMicrotask(() => {
          for (const chunk of response.chunks ?? []) {
            response.emit("data", chunk);
          }
          response.emit("end");
        });
      });
    };
    return request;
  };
}

function fakeResponse({
  statusCode = 200,
  headers = { "content-type": "text/plain" },
  chunks = ["ok"],
} = {}) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.headers = headers;
  response.chunks = chunks;
  response.resume = () => {};
  response.destroy = () => {};
  return response;
}

function publicResolver(addresses = ["93.184.216.34"]) {
  const calls = [];
  return {
    calls,
    resolveAll: async (hostname) => {
      calls.push(hostname);
      return addresses;
    },
  };
}

test("rejects unsafe URL forms before request dispatch", async () => {
  for (const url of [
    "http://example.com/page",
    "https://user:pass@example.com/page",
    "https://example.com:8443/page",
    "https://127.0.0.1/page",
    "https://10.0.0.1/page",
    "https://[::1]/page",
    "https://localhost/page",
    "https://service.internal/page",
    "https://example.com/page#fragment",
  ]) {
    const calls = [];
    await assert.rejects(
      fetchPublicWeb(url, {
        resolveAll: async () => ["93.184.216.34"],
        requester: fakeRequester([fakeResponse()], calls),
      }),
      /unsafe|invalid/iu,
      url,
    );
    assert.equal(calls.length, 0, url);
  }
});

test("rejects DNS answers when any address is private or DNS is empty", async () => {
  for (const addresses of [
    ["93.184.216.34", "192.168.1.10"],
    ["93.184.216.34", "fe80::1"],
    ["93.184.216.34", "not-an-address"],
    [],
  ]) {
    const calls = [];
    await assert.rejects(
      fetchPublicWeb("https://public.example/page", {
        resolveAll: async () => addresses,
        requester: fakeRequester([fakeResponse()], calls),
      }),
      /unsafe_dns/iu,
    );
    assert.equal(calls.length, 0);
  }

  await assert.rejects(
    fetchPublicWeb("https://public.example/page", {
      resolveAll: async () => {
        throw new Error("resolver failure");
      },
      requester: fakeRequester([fakeResponse()], []),
    }),
    /dns_failed/iu,
  );
});

test("pins the validated public address while preserving TLS servername and Host", async () => {
  const resolver = publicResolver(["93.184.216.34", "93.184.216.35"]);
  const calls = [];
  const result = await fetchPublicWeb("https://public.example/page?q=1", {
    resolveAll: resolver.resolveAll,
    requester: fakeRequester(
      [
        fakeResponse({
          headers: { "content-type": "text/html; charset=utf-8" },
          chunks: ["<main>Hello <b>world</b></main>"],
        }),
      ],
      calls,
    ),
  });

  assert.deepEqual(resolver.calls, ["public.example"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].servername, "public.example");
  assert.equal(calls[0].headers.host, "public.example");
  assert.equal(calls[0].headers.cookie, undefined);
  assert.equal(calls[0].headers.authorization, undefined);
  assert.ok(calls[0].timeout <= 120_000);
  assert.equal(calls[0].lookup("public.example", {}, () => {}), undefined);
  let lookupResult;
  calls[0].lookup("public.example", {}, (...args) => {
    lookupResult = args;
  });
  assert.deepEqual(lookupResult, [null, "93.184.216.34", 4]);
  calls[0].lookup("public.example", { all: true }, (...args) => {
    lookupResult = args;
  });
  assert.deepEqual(lookupResult, [
    null,
    [{ address: "93.184.216.34", family: 4 }],
  ]);
  assert.equal(result.url, "https://public.example/page?q=1");
  assert.equal(result.text, "Hello world");
  assert.equal(result.contentType, "text/html");
});

test("rejects a short verification interstitial instead of returning a page", async () => {
  await assert.rejects(
    fetchPublicWeb("https://public.example/verification", {
      resolveAll: async () => ["93.184.216.34"],
      requester: fakeRequester([
        fakeResponse({
          headers: { "content-type": "text/html; charset=utf-8" },
          chunks: ["<title>Please wait</title><p>Please wait for verification</p>"],
        }),
      ], []),
    }),
    (error) => {
      assert.equal(error.name, "PublicWebFetchError");
      assert.equal(error.code, "interstitial_response");
      return true;
    },
  );
});

test("rejects a short JavaScript captcha challenge shell", async () => {
  await assert.rejects(
    fetchPublicWeb("https://public.example/challenge", {
      resolveAll: async () => ["93.184.216.34"],
      requester: fakeRequester([
        fakeResponse({
          headers: { "content-type": "text/html; charset=utf-8" },
          chunks: ["<script>enable JavaScript</script><p>captcha challenge</p>"],
        }),
      ], []),
    }),
    /interstitial_response/iu,
  );
});

test("allows substantive content that discusses verification", async () => {
  const text = [
    "Verification is a routine step in the publication process.",
    "This reference page explains the history, materials, and visual details "
      + "of the installation in enough detail for research. ",
  ].join(" ").repeat(8);
  const result = await fetchPublicWeb("https://public.example/article", {
    resolveAll: async () => ["93.184.216.34"],
    requester: fakeRequester([
      fakeResponse({
        headers: { "content-type": "text/html; charset=utf-8" },
        chunks: [`<article>${text}</article>`],
      }),
    ], []),
  });

  assert.match(result.text, /Verification is a routine step/iu);
});

test("rejects empty visible bodies but allows short meaningful text", async () => {
  for (const headers of [
    {
      headers: { "content-type": "text/html; charset=utf-8" },
      chunks: ["<!-- comment --><script>void 0</script> \n\t"],
    },
    {
      headers: { "content-type": "text/plain" },
      chunks: [" \n\t"],
    },
  ]) {
    await assert.rejects(
      fetchPublicWeb("https://public.example/empty", {
        resolveAll: async () => ["93.184.216.34"],
        requester: fakeRequester([
          fakeResponse(headers),
        ], []),
      }),
      (error) => {
        assert.equal(error.name, "PublicWebFetchError");
        assert.equal(error.code, "empty_response");
        return true;
      },
    );
  }

  const result = await fetchPublicWeb("https://public.example/short", {
    resolveAll: async () => ["93.184.216.34"],
    requester: fakeRequester([
      fakeResponse({ chunks: ["OK"] }),
    ], []),
  });
  assert.equal(result.text, "OK");
});

test("revalidates redirects before dispatching the next request", async () => {
  const calls = [];
  const resolver = publicResolver();
  await assert.rejects(
    fetchPublicWeb("https://public.example/start", {
      resolveAll: resolver.resolveAll,
      requester: fakeRequester(
        [
          fakeResponse({
            statusCode: 302,
            headers: {
              location: "https://127.0.0.1/private",
            },
            chunks: [],
          }),
        ],
        calls,
      ),
    }),
    /unsafe/iu,
  );
  assert.equal(calls.length, 1);
});

test("enforces response byte, content-type, and redirect bounds", async () => {
  const tooLargeCalls = [];
  await assert.rejects(
    fetchPublicWeb("https://public.example/large", {
      resolveAll: async () => ["93.184.216.34"],
      maxBytes: 4,
      requester: fakeRequester(
        [
          fakeResponse({
            chunks: ["12345"],
          }),
        ],
        tooLargeCalls,
      ),
    }),
    /response_too_large/iu,
  );
  assert.equal(tooLargeCalls.length, 1);

  await assert.rejects(
    fetchPublicWeb("https://public.example/binary", {
      resolveAll: async () => ["93.184.216.34"],
      requester: fakeRequester([
        fakeResponse({
          headers: { "content-type": "application/octet-stream" },
        }),
      ], []),
    }),
    /unsupported_response/iu,
  );

  const redirectCalls = [];
  await assert.rejects(
    fetchPublicWeb("https://public.example/one", {
      resolveAll: async () => ["93.184.216.34"],
      maxRedirects: 1,
      requester: fakeRequester(
        [
          fakeResponse({
            statusCode: 302,
            headers: { location: "https://public.example/two" },
            chunks: [],
          }),
          fakeResponse({
            statusCode: 302,
            headers: { location: "https://public.example/three" },
            chunks: [],
          }),
        ],
        redirectCalls,
      ),
    }),
    /redirect_limit/iu,
  );
  assert.equal(redirectCalls.length, 2);
});

test("classifies only global-unicast IP addresses as safe", () => {
  for (const address of [
    "10.0.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "192.168.1.1",
    "224.0.0.1",
    "192.0.2.1",
    "::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
  ]) {
    assert.equal(isGlobalUnicastAddress(address), false, address);
  }
  assert.equal(isGlobalUnicastAddress("93.184.216.34"), true);
  assert.equal(isGlobalUnicastAddress("2001:4860:4860::8888"), true);
});

test("profile fail-closes builtin webfetch and allows only public_webfetch", async () => {
  const profile = await readFile(
    new URL("../.opencode/agents/koler-sales.md", import.meta.url),
    "utf8",
  );
  assert.match(profile, /"\*":\s*deny/u);
  assert.match(profile, /webfetch:\s*deny/u);
  assert.match(profile, /public_webfetch:\s*allow/u);
  assert.match(profile, /только custom tool `public_webfetch`/iu);
  assert.match(profile, /builtin[\s\S]*?`webfetch` запрещён/iu);
});

test("custom tool is a thin adapter over the safe transport", async () => {
  const adapter = await readFile(
    new URL("../.opencode/tools/public_webfetch.js", import.meta.url),
    "utf8",
  );
  assert.match(adapter, /from "@opencode-ai\/plugin"/u);
  assert.match(adapter, /export default tool\(/u);
  assert.match(adapter, /public_webfetch|public HTTPS/iu);
  assert.match(adapter, /fetchPublicWeb\(args\.url\)/u);
  assert.doesNotMatch(adapter, /fetch\(args\.url\)/u);
});

test("producer excerpt stays hash-identical after consumer normalization", async () => {
  const adapter = await readFile(
    new URL("../.opencode/tools/public_webfetch.js", import.meta.url),
    "utf8",
  );
  assert.match(adapter, /slice\(0, 12_000\)\.trim\(\)/u);

  const page = "x".repeat(11_999) + " \ntrailing content";
  const producer = page.replace(/\s+/gu, " ").trim().slice(0, 12_000).trim();
  const consumer = producer.replace(/\s+/gu, " ").slice(0, 12_000);
  const sha256 = (value) =>
    createHash("sha256").update(value, "utf8").digest("hex");

  assert.ok(page.length > 12_000);
  assert.equal(producer.length, 11_999);
  assert.ok(!/\s/u.test(producer.at(-1)));
  assert.equal(sha256(producer), sha256(consumer));
});
