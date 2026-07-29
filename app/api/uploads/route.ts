import { env } from "cloudflare:workers";
import {
  createUploadKey,
  MAX_UPLOAD_BYTES,
  UploadValidationError,
  uploadSource,
  validateImageUpload,
  validateUploadKey,
} from "@/lib/upload-guard.mjs";
import { checkRequestLimits } from "@/lib/request-limit";

export const dynamic = "force-dynamic";

const MAX_MULTIPART_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024;
const noStoreHeaders = {
  "Cache-Control": "no-store",
};

type StoredUpload = {
  body: ReadableStream<Uint8Array>;
  size: number;
  etag?: string;
  httpEtag?: string;
  httpMetadata?: {
    contentType?: string;
  };
};

type UploadBucket = {
  put(
    key: string,
    value: ReadableStream<Uint8Array>,
    options: { httpMetadata: { contentType: string } },
  ): Promise<unknown>;
  get(key: string): Promise<StoredUpload | null>;
};

function bucket() {
  return (env as unknown as { UPLOADS?: UploadBucket }).UPLOADS;
}

function errorResponse(
  status: number,
  error: string,
  code: string,
  details?: Record<string, unknown>,
) {
  return Response.json(
    { error, code, ...details },
    { status, headers: noStoreHeaders },
  );
}

export async function POST(request: Request) {
  const uploads = bucket();
  if (!uploads) {
    return errorResponse(
      503,
      "Загрузка фото временно недоступна.",
      "uploads_unavailable",
    );
  }
  const limit = await checkRequestLimits(request, [
    {
      name: "uploads-ten-minutes",
      max: 6,
      windowSeconds: 600,
      scope: "visitor",
    },
    {
      name: "uploads-stand-ten-minutes",
      max: 120,
      windowSeconds: 600,
      scope: "stand",
    },
  ]);
  if (!limit.allowed) {
    const response = errorResponse(
      429,
      "Стенд получил много фотографий. Подождите немного и повторите загрузку.",
      "upload_rate_limited",
    );
    response.headers.set("Retry-After", String(limit.retryAfterSeconds));
    return response;
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) {
    return errorResponse(
      413,
      "Выберите фотографию до 8 МБ.",
      "file_too_large",
      { maxBytes: MAX_UPLOAD_BYTES },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(
      400,
      "Добавьте фотографию в форму.",
      "invalid_form",
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return errorResponse(
      400,
      "Добавьте фотографию в форму.",
      "file_required",
    );
  }

  try {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const image = validateImageUpload({
      name: file.name,
      declaredType: file.type.toLowerCase(),
      size: file.size,
      head,
    });
    const key = createUploadKey(image.contentType);
    await uploads.put(key, file.stream(), {
      httpMetadata: { contentType: image.contentType },
    });

    return Response.json(
      {
        attachment: {
          name: image.name,
          src: uploadSource(key),
          alt: `Фото клиента: ${image.name}`,
        },
        upload: {
          contentType: image.contentType,
          size: file.size,
        },
      },
      { status: 201, headers: noStoreHeaders },
    );
  } catch (error) {
    if (error instanceof UploadValidationError) {
      return errorResponse(error.status, error.message, error.code, {
        maxBytes: MAX_UPLOAD_BYTES,
      });
    }
    throw error;
  }
}

export async function GET(request: Request) {
  const uploads = bucket();
  if (!uploads) {
    return errorResponse(
      503,
      "Загрузка фото временно недоступна.",
      "uploads_unavailable",
    );
  }

  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!validateUploadKey(key)) {
    return errorResponse(
      400,
      "Некорректная ссылка на изображение.",
      "invalid_upload_key",
    );
  }

  const object = await uploads.get(key);
  if (!object) {
    return errorResponse(404, "Изображение не найдено.", "upload_not_found");
  }

  const headers = new Headers({
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Length": String(object.size),
    "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  });
  if (object.httpEtag) {
    headers.set("ETag", object.httpEtag);
  } else if (object.etag) {
    headers.set("ETag", `"${object.etag}"`);
  }
  return new Response(object.body, { headers });
}
