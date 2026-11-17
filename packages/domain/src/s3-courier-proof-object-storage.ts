import { createHash, createHmac } from "node:crypto";
import type { CourierProofObjectStorage } from "./postgres-courier-delivery-evidence.js";

export interface S3CourierProofStorageConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const hmac = (key: Buffer | string, value: string, encoding?: "hex") =>
  createHmac("sha256", key).update(value, "utf8").digest(encoding ?? undefined) as Buffer | string;
const amzDate = (date: Date) => date.toISOString().replace(/[:-]|\.\d{3}/g, "");
const encodePath = (value: string) => value.split("/").map(part => encodeURIComponent(part).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
const encodeQuery = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const hex = (value: Buffer | string) => Buffer.isBuffer(value) ? value.toString("hex") : value;

function signingKey(secret: string, date: string, region: string): Buffer {
  const dateKey = createHmac("sha256", `AWS4${secret}`).update(date, "utf8").digest();
  const regionKey = createHmac("sha256", dateKey).update(region, "utf8").digest();
  const serviceKey = createHmac("sha256", regionKey).update("s3", "utf8").digest();
  return createHmac("sha256", serviceKey).update("aws4_request", "utf8").digest();
}

/**
 * S3-compatible private object storage adapter (AWS S3 / Cloudflare R2).
 * Upload URLs are short-lived, single-object PUT URLs. S3 validates the SHA-256
 * checksum during PUT; HEAD returns that server-validated checksum for finalize.
 */
export class S3CourierProofObjectStorage implements CourierProofObjectStorage {
  private readonly endpoint: URL;
  constructor(
    private readonly config: S3CourierProofStorageConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => Date = () => new Date()
  ) {
    this.endpoint = new URL(config.endpoint);
    if (this.endpoint.protocol !== "https:") throw new Error("Courier proof storage endpoint must use HTTPS");
    if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(config.bucket)) throw new Error("Invalid courier proof storage bucket");
    if (!/^[a-z0-9-]{1,64}$/.test(config.region)) throw new Error("Invalid courier proof storage region");
  }

  private objectUrl(objectKey: string): URL {
    const url = new URL(this.endpoint);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodePath(this.config.bucket)}/${encodePath(objectKey)}`;
    return url;
  }

  async createUploadUrl(input: {
    objectKey: string;
    contentType: "image/jpeg" | "image/png" | "image/webp";
    contentLength: number;
    contentSha256: string;
    expiresAtUtc: string;
  }): Promise<string> {
    const url = this.objectUrl(input.objectKey);
    const now = this.now();
    const date = amzDate(now);
    const day = date.slice(0, 8);
    const scope = `${day}/${this.config.region}/s3/aws4_request`;
    const checksum = Buffer.from(input.contentSha256, "hex").toString("base64");
    const headers = {
      "content-type": input.contentType,
      "host": url.host,
      "x-amz-checksum-sha256": checksum
    };
    const signedHeaders = "content-type;host;x-amz-checksum-sha256";
    const expires = Math.max(1, Math.min(300, Math.floor((new Date(input.expiresAtUtc).getTime() - now.getTime()) / 1000)));
    const params: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.config.accessKeyId}/${scope}`,
      "X-Amz-Date": date,
      "X-Amz-Expires": String(expires),
      "X-Amz-SignedHeaders": signedHeaders
    };
    if (this.config.sessionToken) params["X-Amz-Security-Token"] = this.config.sessionToken;
    const canonicalQuery = Object.entries(params).sort(([a],[b]) => a.localeCompare(b))
      .map(([key,value]) => `${encodeQuery(key)}=${encodeQuery(value)}`).join("&");
    const canonicalHeaders = `content-type:${input.contentType}\nhost:${url.host}\nx-amz-checksum-sha256:${checksum}\n`;
    const canonicalRequest = ["PUT", url.pathname, canonicalQuery, canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256(canonicalRequest)].join("\n");
    const signature = createHmac("sha256", signingKey(this.config.secretAccessKey, day, this.config.region))
      .update(stringToSign, "utf8").digest("hex");
    url.search = `${canonicalQuery}&X-Amz-Signature=${signature}`;
    return url.toString();
  }

  async inspectObject(input: { objectKey: string }): Promise<
    | { exists: false }
    | { exists: true; contentType: string; contentLength: number; contentSha256: string }
  > {
    const url = this.objectUrl(input.objectKey);
    const date = amzDate(this.now());
    const day = date.slice(0, 8);
    const scope = `${day}/${this.config.region}/s3/aws4_request`;
    const payloadHash = sha256("");
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": date
    };
    if (this.config.sessionToken) headers["x-amz-security-token"] = this.config.sessionToken;
    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers).sort().map(key => `${key}:${headers[key].trim()}\n`).join("");
    const canonicalRequest = ["HEAD", url.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256(canonicalRequest)].join("\n");
    const signature = createHmac("sha256", signingKey(this.config.secretAccessKey, day, this.config.region))
      .update(stringToSign, "utf8").digest("hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const response = await this.fetchImpl(url, {
      method: "HEAD",
      headers: { ...headers, authorization }
    });
    if (response.status === 404 || response.status === 403) return { exists: false };
    if (!response.ok) throw new Error("Courier proof storage inspection failed");
    const checksum = response.headers.get("x-amz-checksum-sha256");
    const contentType = response.headers.get("content-type");
    const contentLength = Number(response.headers.get("content-length"));
    if (!checksum || !contentType || !Number.isSafeInteger(contentLength) || contentLength < 1) {
      throw new Error("Courier proof object is missing trusted checksum metadata");
    }
    return {
      exists: true,
      contentType: contentType.split(";")[0]!.trim(),
      contentLength,
      contentSha256: Buffer.from(checksum, "base64").toString("hex")
    };
  }
}
