import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_UPLOAD_BYTES,
  resolveVisionImageUrl,
  validateImageUpload,
} from "./upload-guard.mjs";

export const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;

function imageTooLargeError() {
  const error = new Error("Image is too large");
  error.code = "image_too_large";
  return error;
}

export async function responseBytesWithinLimit(
  response,
  maxBytes = MAX_UPLOAD_BYTES,
) {
  if (!response.body) throw new Error("Image response has no body");
  const contentLength = response.headers.get("content-length");
  const declaredSize = contentLength === null ? null : Number(contentLength);
  if (
    declaredSize !== null &&
    Number.isFinite(declaredSize) &&
    declaredSize > maxBytes
  ) {
    throw imageTooLargeError();
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw imageTooLargeError();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function downloadVisionImage({
  attachment,
  standUrl,
  fetchImpl = fetch,
  timeoutMs = IMAGE_DOWNLOAD_TIMEOUT_MS,
}) {
  const imageUrl = resolveVisionImageUrl(attachment?.src, standUrl);
  if (!imageUrl) return null;

  const response = await fetchImpl(imageUrl, {
    headers: { accept: "image/jpeg, image/png, image/webp" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Image download ${response.status}`);
  }

  const bytes = await responseBytesWithinLimit(response);
  const contentType = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const image = validateImageUpload({
    name: attachment?.name,
    declaredType: contentType,
    size: bytes.byteLength,
    head: bytes.subarray(0, 16),
  });

  const directory = await mkdtemp(join(tmpdir(), "koler-vision-"));
  const path = join(directory, `image.${image.extension}`);
  try {
    await writeFile(path, bytes, { mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory,
    path,
    contentType: image.contentType,
    size: bytes.byteLength,
  };
}
