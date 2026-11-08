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

export interface IntegrationRegistryStore {
  get(tenantId: string, integrationId: string): Promise<IntegrationRegistration | null>;
  list(tenantId: string, family?: IntegrationFamily): Promise<IntegrationRegistration[]>;
  put(registration: IntegrationRegistration): Promise<void>;
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
  constructor(private readonly store: IntegrationRegistryStore) {}

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

  async list(tenantId: string, family?: IntegrationFamily): Promise<IntegrationRegistration[]> {
    if (!nonEmpty(tenantId)) throw new Error("INVALID_TENANT_ID");
    return this.store.list(tenantId, family);
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
  async recordEvent(event: IntegrationEvent): Promise<"inserted" | "duplicate"> {
    const key = [event.tenantId, event.integrationId, event.providerEventId].join(":");
    if (this.events.has(key)) return "duplicate";
    this.events.add(key);
    return "inserted";
  }
}
