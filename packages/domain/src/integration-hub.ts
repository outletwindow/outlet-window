/**
 * Provider-neutral integration registry for Outlet Window.
 * Stores references to secrets, never secret material. Provider-specific adapters
 * are injected by the application at composition time.
 */
export const INTEGRATION_FAMILIES = [
  "payments", "commerce", "pos", "erp", "carriers", "maps"
] as const;
export type IntegrationFamily = typeof INTEGRATION_FAMILIES[number];

export type IntegrationStatus = "pending" | "connected" | "degraded" | "suspended" | "disconnected";

export interface IntegrationRegistration {
  id: string;
  tenantId: string;
  family: IntegrationFamily;
  providerKey: string;
  displayName: string;
  status: IntegrationStatus;
  secretReference?: string;
  capabilities: readonly string[];
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface IntegrationEvent<T = unknown> {
  tenantId: string;
  integrationId: string;
  providerEventId: string;
  eventType: string;
  occurredAtUtc: string;
  idempotencyKey: string;
  payload: T;
}

export interface IntegrationEventReceipt {
  accepted: boolean;
  duplicate: boolean;
  reason?: "integration_not_found" | "integration_not_active" | "invalid_event";
}

export interface IntegrationSecretReferenceValidator {
  isAuthorizedReference(tenantId: string, reference: string): Promise<boolean>;
}

export interface IntegrationConnectionVerifier {
  verify(registration: IntegrationRegistration): Promise<{ connected: boolean }>;
}

export interface IntegrationRegistryStore {
  get(tenantId: string, integrationId: string): Promise<IntegrationRegistration | null>;
  list(tenantId: string, family?: IntegrationFamily): Promise<IntegrationRegistration[]>;
  put(registration: IntegrationRegistration): Promise<void>;
  updateStatus(tenantId: string, integrationId: string, expectedStatus: IntegrationStatus, nextStatus: IntegrationStatus, updatedAtUtc: string): Promise<"updated" | "conflict">;
  updateSecretReference(tenantId: string, integrationId: string, secretReference: string, updatedAtUtc: string): Promise<"updated" | "not_found">;
  recordEvent(event: IntegrationEvent): Promise<"inserted" | "duplicate">;
}

function nonEmpty(value: unknown, max = 200): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function validUtc(value: string): boolean {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || !value.endsWith("Z")) return false;
  const canonical = new Date(time).toISOString();
  return value === canonical || value === canonical.replace(/\.000Z$/, "Z");
}

export class IntegrationHub {
  constructor(
    private readonly store: IntegrationRegistryStore,
    private readonly verifiers: ReadonlyMap<string, IntegrationConnectionVerifier> = new Map(),
    private readonly secretReferenceValidator?: IntegrationSecretReferenceValidator
  ) {}

  async register(input: IntegrationRegistration): Promise<void> {
    if (!nonEmpty(input.id) || !nonEmpty(input.tenantId) ||
        !nonEmpty(input.providerKey) || !nonEmpty(input.displayName) ||
        !INTEGRATION_FAMILIES.includes(input.family) ||
        !["pending", "connected", "degraded", "suspended", "disconnected"].includes(input.status) ||
        !Array.isArray(input.capabilities) ||
        input.capabilities.some((item) => !nonEmpty(item, 100)) ||
        (input.secretReference !== undefined && !nonEmpty(input.secretReference, 500)) ||
        !validUtc(input.createdAtUtc) || !validUtc(input.updatedAtUtc) ||
        Date.parse(input.updatedAtUtc) < Date.parse(input.createdAtUtc)) {
      throw new Error("INVALID_INTEGRATION_REGISTRATION");
    }
    await this.store.put({ ...input, capabilities: [...new Set(input.capabilities)] });
  }

  async get(tenantId: string, integrationId: string): Promise<IntegrationRegistration | null> {
    if (!nonEmpty(tenantId) || !nonEmpty(integrationId)) throw new Error("INVALID_INTEGRATION_LOOKUP");
    return this.store.get(tenantId, integrationId);
  }

  async list(tenantId: string, family?: IntegrationFamily): Promise<IntegrationRegistration[]> {
    if (!nonEmpty(tenantId)) throw new Error("INVALID_TENANT_ID");
    return this.store.list(tenantId, family);
  }

  async suspend(tenantId: string, integrationId: string, updatedAtUtc: string): Promise<"suspended" | "not_found" | "invalid_transition"> {
    if (!nonEmpty(tenantId) || !nonEmpty(integrationId) || !validUtc(updatedAtUtc)) {
      throw new Error("INVALID_INTEGRATION_STATUS_UPDATE");
    }
    const current = await this.store.get(tenantId, integrationId);
    if (!current) return "not_found";
    if (current.status === "suspended") return "suspended";
    if (current.status === "disconnected") return "invalid_transition";
    const result = await this.store.updateStatus(
      tenantId, integrationId, current.status, "suspended", updatedAtUtc
    );
    return result === "updated" ? "suspended" : "invalid_transition";
  }

  async rotateSecretReference(
    tenantId: string,
    integrationId: string,
    secretReference: string,
    updatedAtUtc: string
  ): Promise<"rotated" | "not_found" | "invalid_reference" | "validator_not_configured"> {
    if (!nonEmpty(tenantId) || !nonEmpty(integrationId) || !validUtc(updatedAtUtc)) {
      throw new Error("INVALID_INTEGRATION_SECRET_ROTATION");
    }
    // Only opaque references are accepted; raw credentials must never enter this API.
    if (!/^vault:\/\/[a-zA-Z0-9/_-]{3,450}$/.test(secretReference) || secretReference.includes("..")) {
      return "invalid_reference";
    }
    if (!this.secretReferenceValidator) return "validator_not_configured";
    if (!(await this.secretReferenceValidator.isAuthorizedReference(tenantId, secretReference))) {
      return "invalid_reference";
    }
    const current = await this.store.get(tenantId, integrationId);
    if (!current) return "not_found";
    const updated = await this.store.updateSecretReference(
      tenantId, integrationId, secretReference, updatedAtUtc
    );
    return updated === "updated" ? "rotated" : "not_found";
  }

  async reconnect(
    tenantId: string,
    integrationId: string,
    updatedAtUtc: string
  ): Promise<"pending" | "not_found" | "invalid_transition"> {
    if (!nonEmpty(tenantId) || !nonEmpty(integrationId) || !validUtc(updatedAtUtc)) {
      throw new Error("INVALID_INTEGRATION_STATUS_UPDATE");
    }
    const current = await this.store.get(tenantId, integrationId);
    if (!current) return "not_found";
    if (current.status === "pending") return "pending";
    if (current.status !== "suspended" && current.status !== "disconnected") {
      return "invalid_transition";
    }
    const updated = await this.store.updateStatus(
      tenantId, integrationId, current.status, "pending", updatedAtUtc
    );
    return updated === "updated" ? "pending" : "invalid_transition";
  }

  async verifyConnection(
    tenantId: string,
    integrationId: string,
    checkedAtUtc: string
  ): Promise<"connected" | "verification_failed" | "not_found" | "provider_not_configured" | "invalid_transition"> {
    if (!nonEmpty(tenantId) || !nonEmpty(integrationId) || !validUtc(checkedAtUtc)) {
      throw new Error("INVALID_INTEGRATION_VERIFICATION");
    }
    const current = await this.store.get(tenantId, integrationId);
    if (!current) return "not_found";
    if (current.status === "suspended" || current.status === "disconnected") return "invalid_transition";
    const verifier = this.verifiers.get(current.providerKey);
    if (!verifier) return "provider_not_configured";
    let connected = false;
    try {
      connected = (await verifier.verify(current)).connected === true;
    } catch {
      connected = false;
    }
    const nextStatus: IntegrationStatus = connected ? "connected" : "degraded";
    const updated = await this.store.updateStatus(
      tenantId, integrationId, current.status, nextStatus, checkedAtUtc
    );
    if (updated !== "updated") return "invalid_transition";
    return connected ? "connected" : "verification_failed";
  }

  async acceptEvent<T>(event: IntegrationEvent<T>): Promise<IntegrationEventReceipt> {
    if (!nonEmpty(event.tenantId) || !nonEmpty(event.integrationId) ||
        !nonEmpty(event.providerEventId) || !nonEmpty(event.eventType) ||
        !nonEmpty(event.idempotencyKey) || !validUtc(event.occurredAtUtc) ||
        event.payload === undefined || event.payload === null) {
      return { accepted: false, duplicate: false, reason: "invalid_event" };
    }
    const integration = await this.store.get(event.tenantId, event.integrationId);
    if (!integration) return { accepted: false, duplicate: false, reason: "integration_not_found" };
    if (integration.status !== "connected") {
      return { accepted: false, duplicate: false, reason: "integration_not_active" };
    }
    const result = await this.store.recordEvent(event as IntegrationEvent);
    return { accepted: true, duplicate: result === "duplicate" };
  }
}

/** In-memory adapter for deterministic unit tests and local development only. */
export class InMemoryIntegrationRegistryStore implements IntegrationRegistryStore {
  private readonly integrations = new Map<string, IntegrationRegistration>();
  private readonly events = new Set<string>();
  private key(tenantId: string, id: string): string { return tenantId + ":" + id; }

  async get(tenantId: string, integrationId: string): Promise<IntegrationRegistration | null> {
    return this.integrations.get(this.key(tenantId, integrationId)) ?? null;
  }
  async list(tenantId: string, family?: IntegrationFamily): Promise<IntegrationRegistration[]> {
    return [...this.integrations.values()].filter((item) =>
      item.tenantId === tenantId && (!family || item.family === family));
  }
  async put(registration: IntegrationRegistration): Promise<void> {
    const key = this.key(registration.tenantId, registration.id);
    if (this.integrations.has(key)) throw new Error("INTEGRATION_ALREADY_EXISTS");
    this.integrations.set(key, registration);
  }
  async updateSecretReference(tenantId: string, integrationId: string, secretReference: string, updatedAtUtc: string): Promise<"updated" | "not_found"> {
    const key = this.key(tenantId, integrationId);
    const current = this.integrations.get(key);
    if (!current) return "not_found";
    this.integrations.set(key, { ...current, secretReference, updatedAtUtc });
    return "updated";
  }
  async updateStatus(tenantId: string, integrationId: string, expectedStatus: IntegrationStatus, nextStatus: IntegrationStatus, updatedAtUtc: string): Promise<"updated" | "conflict"> {
    const key = this.key(tenantId, integrationId);
    const current = this.integrations.get(key);
    if (!current || current.status !== expectedStatus) return "conflict";
    this.integrations.set(key, { ...current, status: nextStatus, updatedAtUtc });
    return "updated";
  }
  async recordEvent(event: IntegrationEvent): Promise<"inserted" | "duplicate"> {
    const key = [event.tenantId, event.integrationId, event.providerEventId].join(":");
    if (this.events.has(key)) return "duplicate";
    this.events.add(key);
    return "inserted";
  }
}
