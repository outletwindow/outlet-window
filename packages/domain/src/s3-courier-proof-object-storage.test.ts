import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { S3CourierProofObjectStorage } from "./s3-courier-proof-object-storage.js";

const objectBytes = Buffer.from("proof image bytes");
const digest = createHash("sha256").update(objectBytes).digest("hex");
const config = {
  endpoint: "https://objects.example.test",
  bucket: "outlet-window-private",
  region: "auto",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key"
};

describe("S3CourierProofObjectStorage", () => {
  it("creates a short-lived signed PUT URL bound to MIME type and SHA-256", async () => {
    const storage = new S3CourierProofObjectStorage(config, vi.fn(), () => new Date("2026-11-17T12:00:00.000Z"));
    const url = new URL(await storage.createUploadUrl({
      objectKey: "courier-delivery-proof/upload-123",
      contentType: "image/jpeg",
      contentLength: 2048,
      contentSha256: digest,
      expiresAtUtc: "2026-11-17T12:05:00.000Z"
    }));
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe("/outlet-window-private/courier-delivery-proof/upload-123");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host;if-none-match;x-amz-checksum-sha256");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hashes actual object bytes and verifies object metadata with GET", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response(objectBytes, {
      status: 200,
      headers: {
        "content-type": "image/jpeg",
        "content-length": String(objectBytes.length)
      }
    }));
    const storage = new S3CourierProofObjectStorage(config, fetchImpl, () => new Date("2026-11-17T12:00:00.000Z"));
    await expect(storage.inspectObject({ objectKey: "courier-delivery-proof/upload-123" }))
      .resolves.toEqual({
        exists: true, contentType: "image/jpeg", contentLength: objectBytes.length, contentSha256: digest
      });
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ method: "GET" }));
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({
      "x-amz-content-sha256": expect.any(String),
      "x-amz-date": "20261117T120000Z",
      authorization: expect.stringContaining("AWS4-HMAC-SHA256")
    });
  });

  it("distinguishes a missing object from storage failures", async () => {
    const missing = new S3CourierProofObjectStorage(config, vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response(null, { status: 404 })));
    await expect(missing.inspectObject({ objectKey: "missing" })).resolves.toEqual({ exists: false });
    const denied = new S3CourierProofObjectStorage(config, vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response(null, { status: 403 })));
    await expect(denied.inspectObject({ objectKey: "private" })).rejects.toThrow("inspection failed");
  });

  it("rejects invalid upload size, checksum, and expired URL requests", async () => {
    const storage = new S3CourierProofObjectStorage(config, vi.fn(), () => new Date("2026-11-17T12:00:00.000Z"));
    const base = {
      objectKey: "courier-delivery-proof/upload-123",
      contentType: "image/jpeg" as const,
      contentLength: 128,
      contentSha256: digest,
      expiresAtUtc: "2026-11-17T12:05:00.000Z"
    };
    await expect(storage.createUploadUrl({ ...base, contentLength: 10 * 1024 * 1024 + 1 }))
      .rejects.toThrow("Invalid courier proof upload constraints");
    await expect(storage.createUploadUrl({ ...base, contentSha256: "bad" }))
      .rejects.toThrow("Invalid courier proof upload constraints");
    await expect(storage.createUploadUrl({ ...base, expiresAtUtc: "2026-11-17T11:59:59.000Z" }))
      .rejects.toThrow("expiry must be in the future");
  });

  it("rejects non-HTTPS storage endpoints", () => {
    expect(() => new S3CourierProofObjectStorage({ ...config, endpoint: "http://objects.example.test" }))
      .toThrow("must use HTTPS");
  });
});
