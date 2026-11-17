import { describe, expect, it, vi } from "vitest";
import { S3CourierProofObjectStorage } from "./s3-courier-proof-object-storage.js";

const digest = "ab".repeat(32);
const checksum = Buffer.from(digest, "hex").toString("base64");
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
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host;x-amz-checksum-sha256");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns server-validated checksum and object metadata from HEAD", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response(null, {
      status: 200,
      headers: {
        "content-type": "image/jpeg",
        "content-length": "2048",
        "x-amz-checksum-sha256": checksum
      }
    }));
    const storage = new S3CourierProofObjectStorage(config, fetchImpl, () => new Date("2026-11-17T12:00:00.000Z"));
    await expect(storage.inspectObject({ objectKey: "courier-delivery-proof/upload-123" }))
      .resolves.toEqual({
        exists: true, contentType: "image/jpeg", contentLength: 2048, contentSha256: digest
      });
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ method: "HEAD" }));
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

  it("rejects non-HTTPS storage endpoints", () => {
    expect(() => new S3CourierProofObjectStorage({ ...config, endpoint: "http://objects.example.test" }))
      .toThrow("must use HTTPS");
  });
});
