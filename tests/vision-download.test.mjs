import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import test from "node:test";

import {
  downloadVisionImage,
  responseBytesWithinLimit,
} from "../lib/upload-vision.mjs";
import { uploadSource } from "../lib/upload-guard.mjs";

const key = "customer-images/018fa79939e87903ba250514d02e70b8.jpg";
const src = uploadSource(key);

test("downloads the exact same-stand image bytes to a private temp file", async () => {
  const expected = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
  ]);
  const standUrl = "https://koler.test";
  const downloaded = await downloadVisionImage({
    attachment: { name: "секция.jpg", src },
    standUrl,
    fetchImpl: async (url) => {
      assert.equal(String(url), new URL(src, standUrl).href);
      return new Response(expected, {
        status: 200,
        headers: {
          "content-length": String(expected.byteLength),
          "content-type": "image/jpeg",
        },
      });
    },
  });
  assert(downloaded);
  try {
    assert.deepEqual(await readFile(downloaded.path), expected);
    assert.equal((await stat(downloaded.path)).mode & 0o777, 0o600);
    assert.match(downloaded.path, /\.jpg$/);
  } finally {
    await rm(downloaded.directory, { recursive: true, force: true });
  }
});

test("stops a chunked response as soon as the byte limit is crossed", async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2, 3]));
        controller.enqueue(Uint8Array.from([4, 5]));
        controller.close();
      },
    }),
  );

  await assert.rejects(
    responseBytesWithinLimit(response, 4),
    (error) => error?.code === "image_too_large",
  );
});
