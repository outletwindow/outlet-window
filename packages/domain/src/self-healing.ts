export type RecoverySeverity = "transient" | "dependency_unavailable" | "stale_lease" | "invariant_violation" | "security_violation" | "data_loss" | "unknown";
export type RecoveryAction = "retry_idempotent_job" | "reclaim_expired_lease" | "restart_unhealthy_service" | "manual_review";
export type RecoveryOutcome = "recovered" | "retry_scheduled" | "approval_required" | "blocked" | "failed";

export interface RecoveryIncident {
  incidentId: string;
  service: string;
  severity: RecoverySeverity;
  idempotent: boolean;
  leaseExpired?: boolean;
  correlationId?: string;
}
export interface RecoveryRecord {
  incidentId: string;
  service: string;
  severity: RecoverySeverity;
  action: RecoveryAction;
  outcome: RecoveryOutcome;
  reason: string;
  occurredAtUtc: string;
}
export interface RecoveryStateStore {
  wasRecentlyAttempted(service: string, action: RecoveryAction, cooldownSeconds: number): Promise<boolean>;
  getAutomaticAttemptCount?(incidentId: string): Promise<number>;
  record(record: RecoveryRecord): Promise<void>;
}
export interface RecoveryExecutor {
  execute(action: Exclude<RecoveryAction, "manual_review">, incident: RecoveryIncident): Promise<"success" | "retryable_failure" | "permanent_failure">;
}
export interface SelfHealingConfig {
  cooldownSeconds?: number;
  maxAutomaticAttemptsPerIncident?: number;
  now?: () => Date;
}

/**
 * Fail-closed recovery policy. Only idempotent work and already-expired leases
 * can be repaired automatically. Financial, security, data-integrity and
 * unknown incidents are never modified automatically.
 */
export class SelfHealingController {
  private readonly cooldownSeconds: number;
  private readonly maxAttempts: number;
  private readonly now: () => Date;
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly state: RecoveryStateStore,
    private readonly executor: RecoveryExecutor,
    config: SelfHealingConfig = {}
  ) {
    this.cooldownSeconds = config.cooldownSeconds ?? 60;
    this.maxAttempts = config.maxAutomaticAttemptsPerIncident ?? 3;
    this.now = config.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.cooldownSeconds) || this.cooldownSeconds < 1 ||
        !Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 10) {
      throw new Error("INVALID_SELF_HEALING_CONFIGURATION");
    }
  }

  async handle(incident: RecoveryIncident): Promise<RecoveryRecord> {
    if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(incident.incidentId) ||
        !/^[a-zA-Z0-9._:-]{1,120}$/.test(incident.service)) {
      throw new Error("INVALID_RECOVERY_INCIDENT");
    }

    const action = this.selectAction(incident);
    if (action === "manual_review") {
      return this.persist(incident, action, "approval_required", "SENSITIVE_OR_UNCLASSIFIED_INCIDENT");
    }

    const count = this.state.getAutomaticAttemptCount
      ? await this.state.getAutomaticAttemptCount(incident.incidentId)
      : (this.attempts.get(incident.incidentId) ?? 0);
    if (count >= this.maxAttempts) {
      return this.persist(incident, action, "blocked", "AUTOMATIC_ATTEMPT_LIMIT_REACHED");
    }
    if (await this.state.wasRecentlyAttempted(incident.service, action, this.cooldownSeconds)) {
      return this.persist(incident, action, "blocked", "RECOVERY_COOLDOWN_ACTIVE");
    }

    this.attempts.set(incident.incidentId, count + 1);
    try {
      const result = await this.executor.execute(action, incident);
      if (result === "success") return this.persist(incident, action, "recovered", "SAFE_RECOVERY_ACTION_SUCCEEDED");
      if (result === "retryable_failure") return this.persist(incident, action, "retry_scheduled", "RECOVERY_ACTION_RETRYABLE_FAILURE");
      return this.persist(incident, action, "failed", "RECOVERY_ACTION_PERMANENT_FAILURE");
    } catch {
      return this.persist(incident, action, "failed", "RECOVERY_ACTION_EXCEPTION");
    }
  }

  private selectAction(incident: RecoveryIncident): RecoveryAction {
    if (incident.severity === "stale_lease" && incident.leaseExpired === true) return "reclaim_expired_lease";
    if ((incident.severity === "transient" || incident.severity === "dependency_unavailable") && incident.idempotent) {
      return "retry_idempotent_job";
    }
    return "manual_review";
  }

  private async persist(
    incident: RecoveryIncident,
    action: RecoveryAction,
    outcome: RecoveryOutcome,
    reason: string
  ): Promise<RecoveryRecord> {
    const record: RecoveryRecord = {
      incidentId: incident.incidentId,
      service: incident.service,
      severity: incident.severity,
      action,
      outcome,
      reason,
      occurredAtUtc: this.now().toISOString()
    };
    await this.state.record(record);
    return record;
  }
}
