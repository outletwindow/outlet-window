export type AuditActorType =
  | "customer"
  | "merchant_user"
  | "shopper"
  | "courier"
  | "platform_user"
  | "ai_agent"
  | "integration"
  | "system";

export type AuditOutcome = "success" | "failure" | "denied" | "pending";
export type AuditSeverity = "info" | "warning" | "high" | "critical";
export type AuditJsonValue =
  | string
  | number
  | boolean
  | null
  | AuditJsonValue[]
  | { [key: string]: AuditJsonValue };

export interface AuditActor {
  id: string;
  type: AuditActorType;
  role?: string;
}

export interface AuditEventInput {
  id: string;
  type: string;
  category: string;
  occurredAt: string;
  actor: AuditActor;
  action: string;
  outcome: AuditOutcome;
  resourceType?: string;
  resourceId?: string;
  tenantId?: string;
  merchantId?: string;
  branchId?: string;
  correlationId: string;
  requestId?: string;
  source: string;
  severity: AuditSeverity;
  approvalId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditEvent extends Omit<AuditEventInput, "metadata"> {
  schemaVersion: 1;
  metadata: Record<string, AuditJsonValue>;
}

const SENSITIVE_KEY =
  /(password|passcode|otp|token|secret|authorization|cookie|card.?number|cvv|recovery.?code|private.?key)/i;

function sanitizeValue(value: unknown, depth: number): AuditJsonValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") return value.slice(0, 1_000);
  if (value instanceof Date) return value.toISOString();
  if (depth >= 5) return "[TRUNCATED]";

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1) ?? null);
  }
  if (typeof value === "object") {
    const result: Record<string, AuditJsonValue> = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      result[key] = SENSITIVE_KEY.test(key)
        ? "[REDACTED]"
        : (sanitizeValue(item, depth + 1) ?? "[UNSUPPORTED]");
    }
    return result;
  }
  return undefined;
}

/**
 * Builds a versioned audit event and removes common secret-bearing fields.
 * This does not provide persistence, tamper resistance, or access control.
 */
export function createAuditEvent(input: AuditEventInput): AuditEvent {
  const metadata = sanitizeValue(input.metadata ?? {}, 0);
  return {
    ...input,
    schemaVersion: 1,
    metadata:
      metadata !== null && !Array.isArray(metadata) && typeof metadata === "object"
        ? metadata
        : {}
  };
}
