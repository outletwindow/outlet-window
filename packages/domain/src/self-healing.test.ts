import { describe, expect, it, vi } from "vitest";
import { SelfHealingController, type RecoveryStateStore, type RecoveryExecutor } from "./self-healing.js";

function setup() {
  const state: RecoveryStateStore = {
    wasRecentlyAttempted: vi.fn(async () => false),
    record: vi.fn(async () => undefined)
  };
  const executor: RecoveryExecutor = { execute: vi.fn(async () => "success" as const) };
  const controller = new SelfHealingController(state, executor, { now: () => new Date("2026-11-08T12:00:00.000Z") });
  return { state, executor, controller };
}

describe("self-healing controller", () => {
  it("automatically retries only idempotent transient jobs", async () => {
    const { controller, executor } = setup();
    await expect(controller.handle({
      incidentId: "inc-1", service: "scheduled-worker", severity: "transient", idempotent: true
    })).resolves.toMatchObject({ action: "retry_idempotent_job", outcome: "recovered" });
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it("reclaims only leases explicitly known to be expired", async () => {
    const { controller, executor } = setup();
    await expect(controller.handle({
      incidentId: "inc-2", service: "fulfillment-worker", severity: "stale_lease",
      idempotent: true, leaseExpired: true
    })).resolves.toMatchObject({ action: "reclaim_expired_lease", outcome: "recovered" });
    expect(executor.execute).toHaveBeenCalledWith("reclaim_expired_lease", expect.any(Object));
  });

  it.each(["invariant_violation", "security_violation", "data_loss", "unknown"] as const)(
    "requires human review for %s incidents", async severity => {
      const { controller, executor } = setup();
      await expect(controller.handle({
        incidentId: "inc-sensitive", service: "payments", severity, idempotent: false
      })).resolves.toMatchObject({ action: "manual_review", outcome: "approval_required" });
      expect(executor.execute).not.toHaveBeenCalled();
    }
  );

  it("blocks recovery while cooldown is active", async () => {
    const { controller, state, executor } = setup();
    vi.mocked(state.wasRecentlyAttempted).mockResolvedValue(true);
    await expect(controller.handle({
      incidentId: "inc-3", service: "api", severity: "transient", idempotent: true
    })).resolves.toMatchObject({ outcome: "blocked", reason: "RECOVERY_COOLDOWN_ACTIVE" });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("caps repeated automatic attempts per incident", async () => {
    const state: RecoveryStateStore = { wasRecentlyAttempted: vi.fn(async () => false), record: vi.fn(async () => undefined) };
    const executor: RecoveryExecutor = { execute: vi.fn(async () => "retryable_failure" as const) };
    const controller = new SelfHealingController(state, executor, { maxAutomaticAttemptsPerIncident: 2 });
    const incident = { incidentId: "inc-4", service: "api", severity: "transient" as const, idempotent: true };
    await controller.handle(incident);
    await controller.handle(incident);
    await expect(controller.handle(incident)).resolves.toMatchObject({ outcome: "blocked", reason: "AUTOMATIC_ATTEMPT_LIMIT_REACHED" });
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed incident identities", async () => {
    const { controller } = setup();
    await expect(controller.handle({
      incidentId: "bad incident", service: "api", severity: "transient", idempotent: true
    })).rejects.toThrow("INVALID_RECOVERY_INCIDENT");
  });
});
