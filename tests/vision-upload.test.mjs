import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createUploadKey,
  imageTypeFromBytes,
  MAX_UPLOAD_BYTES,
  uploadSource,
  validateImageUpload,
  validateUploadKey,
} from "../lib/upload-guard.mjs";

test("accepts a real JPEG signature and builds an opaque public source", () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

  assert.deepEqual(imageTypeFromBytes(jpeg), {
    contentType: "image/jpeg",
    extension: "jpg",
  });

  const key = createUploadKey(
    "image/jpeg",
    () => "018fa799-39e8-7903-ba25-0514d02e70b8",
  );
  assert.equal(
    key,
    "customer-images/018fa79939e87903ba250514d02e70b8.jpg",
  );
  assert.equal(validateUploadKey(key), true);
  assert.equal(
    uploadSource(key),
    "/api/uploads?key=customer-images%2F018fa79939e87903ba250514d02e70b8.jpg",
  );
  assert.equal(MAX_UPLOAD_BYTES, 8 * 1024 * 1024);
});

test("recognizes PNG and WebP from their file signatures", () => {
  const png = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const webp = Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);

  assert.deepEqual(imageTypeFromBytes(png), {
    contentType: "image/png",
    extension: "png",
  });
  assert.deepEqual(imageTypeFromBytes(webp), {
    contentType: "image/webp",
    extension: "webp",
  });
});

test("rejects a file whose declared MIME type does not match its bytes", () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);

  assert.throws(
    () =>
      validateImageUpload({
        name: "подмена.png",
        declaredType: "image/png",
        size: jpeg.byteLength,
        head: jpeg,
      }),
    (error) =>
      error?.code === "type_mismatch" &&
      error?.status === 415 &&
      /JPEG, PNG или WebP/.test(error.message),
  );
});

test("returns a safe original name for a valid upload", () => {
  const png = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);

  assert.deepEqual(
    validateImageUpload({
      name: "../эскиз\u0000.png ",
      declaredType: "image/png",
      size: 2048,
      head: png,
    }),
    {
      name: "эскиз.png",
      contentType: "image/png",
      extension: "png",
    },
  );
});

test("enforces a non-empty eight MiB upload boundary", () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
  const validateSize = (size) =>
    validateImageUpload({
      name: "photo.jpg",
      declaredType: "image/jpeg",
      size,
      head: jpeg,
    });

  assert.doesNotThrow(() => validateSize(MAX_UPLOAD_BYTES));
  assert.throws(
    () => validateSize(0),
    (error) => error?.code === "empty_file" && error?.status === 400,
  );
  assert.throws(
    () => validateSize(MAX_UPLOAD_BYTES + 1),
    (error) => error?.code === "file_too_large" && error?.status === 413,
  );
});

test("wires the UPLOADS bucket and enough multipart headroom", async () => {
  const [hostingSource, nextConfig, route] = await Promise.all([
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/api/uploads/route.ts", import.meta.url),
      "utf8",
    ),
  ]);
  const hosting = JSON.parse(hostingSource);

  assert.equal(hosting.r2, "UPLOADS");
  assert.match(nextConfig, /bodySizeLimit:\s*"9mb"/);
  assert.match(route, /export async function POST/);
  assert.match(route, /export async function GET/);
});
