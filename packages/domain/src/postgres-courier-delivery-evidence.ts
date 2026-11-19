import { randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";

export interface CourierProofObjectStorage {
  createUploadUrl(input: {
    objectKey: string;
    contentType: "image/jpeg" | "image/png" | "image/webp";
    contentLength: number;
    contentSha256: string;
    expiresAtUtc: string;
  }): Promise<string>;
  /** Must inspect the stored object and calculate SHA-256 from the actual bytes. */
  inspectObject(input: { objectKey: string }): Promise<
    | { exists: false }
    | { exists: true; contentType: string; contentLength: number; contentSha256: string }
  >;
}

type UploadRow = {
  id: string;
  tenant_id: string;
  task_id: string;
  courier_id: string;
  object_key: string;
  content_type: "image/jpeg" | "image/png" | "image/webp";
  expected_content_length: string | number;
  expected_content_sha256: string;
  status: "pending" | "verified" | "expired" | "rejected";
  expires_at: Date | string;
  verified_evidence_id: string | null;
  completed_at: Date | string | null;
};

/**
 * Coordinates short-lived upload intents and immutable proof metadata.
 * The injected storage adapter must use a private bucket and verify the actual
 * stored bytes; client-supplied object keys and URLs are never accepted.
 */
export class PostgresCourierDeliveryEvidenceService {
  constructor(
    private readonly pool: PostgresPool,
    private readonly storage: CourierProofObjectStorage,
    private readonly now: () => Date = () => new Date()
  ) {}

  async requestProofUpload(input: {
    tenantId: string;
    taskId: string;
    courierId: string;
    contentType: "image/jpeg" | "image/png" | "image/webp";
    contentLength: number;
    contentSha256: string;
  }): Promise<
    | { outcome: "upload_created"; uploadId: string; uploadUrl: string; expiresAtUtc: string }
    | { outcome: "not_found" | "task_not_ready" | "upload_unavailable" }
  > {
    const task = await this.pool.query<{ status: string }>(
      `SELECT status FROM courier_delivery_tasks
       WHERE tenant_id = $1 AND id = $2 AND courier_id = $3`,
      [input.tenantId, input.taskId, input.courierId]
    );
    if (!task.rows[0]) return { outcome: "not_found" };
    if (task.rows[0].status !== "arrived_at_dropoff") return { outcome: "task_not_ready" };

    const uploadId = randomUUID();
    const objectKey = `courier-delivery-proof/${uploadId}`;
    const expiresAtUtc = new Date(this.now().getTime() + 5 * 60 * 1000).toISOString();
    let uploadUrl: string;
    try {
      uploadUrl = await this.storage.createUploadUrl({
        objectKey,
        contentType: input.contentType,
        contentLength: input.contentLength,
        contentSha256: input.contentSha256,
        expiresAtUtc
      });
      const parsed = new URL(uploadUrl);
      if (parsed.protocol !== "https:") return { outcome: "upload_unavailable" };
    } catch {
      return { outcome: "upload_unavailable" };
    }

    await this.pool.query(
      `INSERT INTO courier_delivery_proof_uploads
        (id, tenant_id, task_id, courier_id, object_key, content_type,
         expected_content_length, expected_content_sha256, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [uploadId, input.tenantId, input.taskId, input.courierId, objectKey,
        input.contentType, input.contentLength, input.contentSha256, expiresAtUtc]
    );
    return { outcome: "upload_created", uploadId, uploadUrl, expiresAtUtc };
  }

  async finalizeProofUpload(input: {
    tenantId: string;
    taskId: string;
    courierId: string;
    uploadId: string;
  }): Promise<
    | { outcome: "verified"; evidenceId: string; verifiedAtUtc: string }
    | { outcome: "not_found" | "task_not_ready" | "upload_missing" | "checksum_mismatch" | "invalid_upload" }
  > {
    const found = await this.pool.query<UploadRow>(
      `SELECT id, tenant_id, task_id, courier_id, object_key, content_type,
              expected_content_length, expected_content_sha256, status, expires_at,
              verified_evidence_id, completed_at
       FROM courier_delivery_proof_uploads
       WHERE tenant_id = $1 AND task_id = $2 AND courier_id = $3 AND id = $4`,
      [input.tenantId, input.taskId, input.courierId, input.uploadId]
    );
    const upload = found.rows[0];
    if (!upload) return { outcome: "not_found" };
    if (upload.status === "verified" && upload.verified_evidence_id && upload.completed_at) {
      return { outcome: "verified", evidenceId: upload.verified_evidence_id, verifiedAtUtc: new Date(upload.completed_at).toISOString() };
    }
    if (upload.status !== "pending") return { outcome: "invalid_upload" };
    if (new Date(upload.expires_at).getTime() <= this.now().getTime()) {
      await this.pool.query(
        "UPDATE courier_delivery_proof_uploads SET status = 'expired' WHERE id = $1 AND status = 'pending'",
        [upload.id]
      );
      return { outcome: "invalid_upload" };
    }

    const task = await this.pool.query<{ status: string }>(
      "SELECT status FROM courier_delivery_tasks WHERE tenant_id = $1 AND id = $2 AND courier_id = $3",
      [input.tenantId, input.taskId, input.courierId]
    );
    if (!task.rows[0]) return { outcome: "not_found" };
    if (task.rows[0].status !== "arrived_at_dropoff") return { outcome: "task_not_ready" };

    let actual: Awaited<ReturnType<CourierProofObjectStorage["inspectObject"]>>;
    try {
      actual = await this.storage.inspectObject({ objectKey: upload.object_key });
    } catch {
      return { outcome: "upload_missing" };
    }
    if (!actual.exists) return { outcome: "upload_missing" };
    if (actual.contentType !== upload.content_type ||
        actual.contentLength !== Number(upload.expected_content_length)) {
      await this.pool.query(
        "UPDATE courier_delivery_proof_uploads SET status = 'rejected' WHERE id = $1 AND status = 'pending'",
        [upload.id]
      );
      return { outcome: "invalid_upload" };
    }
    if (actual.contentSha256 !== upload.expected_content_sha256) {
      await this.pool.query(
        "UPDATE courier_delivery_proof_uploads SET status = 'rejected' WHERE id = $1 AND status = 'pending'",
        [upload.id]
      );
      return { outcome: "checksum_mismatch" };
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<UploadRow>(
        `SELECT id, tenant_id, task_id, courier_id, object_key, content_type,
                expected_content_length, expected_content_sha256, status, expires_at,
                verified_evidence_id, completed_at
         FROM courier_delivery_proof_uploads
         WHERE tenant_id = $1 AND task_id = $2 AND courier_id = $3 AND id = $4
         FOR UPDATE`,
        [input.tenantId, input.taskId, input.courierId, input.uploadId]
      );
      const current = locked.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      if (current.status === "verified" && current.verified_evidence_id && current.completed_at) {
        await client.query("COMMIT");
        return { outcome: "verified", evidenceId: current.verified_evidence_id, verifiedAtUtc: new Date(current.completed_at).toISOString() };
      }
      if (current.status !== "pending" || new Date(current.expires_at).getTime() <= this.now().getTime()) {
        await client.query("ROLLBACK");
        return { outcome: "invalid_upload" };
      }
      const currentTask = await client.query<{ status: string }>(
        "SELECT status FROM courier_delivery_tasks WHERE tenant_id = $1 AND id = $2 AND courier_id = $3 FOR UPDATE",
        [input.tenantId, input.taskId, input.courierId]
      );
      if (!currentTask.rows[0]) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      if (currentTask.rows[0].status !== "arrived_at_dropoff") {
        await client.query("ROLLBACK");
        return { outcome: "task_not_ready" };
      }
      const evidenceId = randomUUID();
      const verifiedAtUtc = this.now().toISOString();
      await client.query(
        `INSERT INTO courier_delivery_evidence
          (id, tenant_id, task_id, evidence_type, verification_method, object_key,
           content_sha256, verified_by, verified_at, metadata)
         VALUES ($1,$2,$3,'proof_of_delivery','private_object_sha256', $4,$5,$6,$7,$8::jsonb)`,
        [evidenceId, input.tenantId, input.taskId, current.object_key,
          actual.contentSha256, input.courierId, verifiedAtUtc,
          JSON.stringify({ contentType: actual.contentType, contentLength: actual.contentLength })]
      );
      await client.query(
        `UPDATE courier_delivery_proof_uploads
         SET status = 'verified', verified_evidence_id = $2, completed_at = $3
         WHERE id = $1 AND status = 'pending'`,
        [current.id, evidenceId, verifiedAtUtc]
      );
      await client.query("COMMIT");
      return { outcome: "verified", evidenceId, verifiedAtUtc };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
