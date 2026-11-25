import { describe, expect, it, vi } from "vitest";
import type { PostgresPool } from "./postgres-iam-store.js";
import { PostgresMoyasarMerchantPayoutConfirmationStore } from "./postgres-moyasar-merchant-payout-confirmation-store.js";

const input = {
  eventRowId: "event-row-1",
  auditActorId: "payout-webhook-service",
  providerKey: "moyasar",
  providerEventId: "evt-payout-1",
  outboxId: "outbox-1",
  providerReference: "payout-ref-1",
  amountMinor: 12500,
  currency: "SAR",
  merchantId: "provider-merchant-1",
  entityId: "provider-entity-1"
};

function fixture(options: { identity?: boolean; duplicate?: boolean } = {}) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("SELECT o.tenant_id")) {
        return {
          rows: options.identity === false ? [] : [{ tenant_id: "tenant-1" }] as Row[],
          rowCount: options.identity === false ? 0 : 1
        };
      }
      if (sql.includes("FROM merchant_payout_provider_events")) {
        return {
          rows: options.duplicate ? [{
            outbox_id: input.outboxId, provider_reference: input.providerReference,
            amount_minor: input.amountMinor, currency: input.currency,
            event_type: "payout_confirmed", signature_verified: true
          }] as Row[] : [],
          rowCount: options.duplicate ? 1 : 0
        };
      }
      if (sql.includes("FROM financial_journals")) {
        return { rows: [{ journal_id: "journal-1" }] as Row[], rowCount: 1 };
      }
      if (sql.includes("post_confirmed_merchant_payout")) {
        return { rows: [{ journal_id: "journal-1" }] as Row[], rowCount: 1 };
      }
      return { rows: [] as Row[], rowCount: 0 };
    },
    release: vi.fn()
  };
  const pool = {
    connect: async () => client
  } as unknown as PostgresPool;
  return { store: new PostgresMoyasarMerchantPayoutConfirmationStore(pool), calls, client };
}

describe("PostgresMoyasarMerchantPayoutConfirmationStore", () => {
  it("binds the event to the mapped provider merchant/entity and atomically posts the journal", async () => {
    const f = fixture();
    await expect(f.store.confirmVerified(input)).resolves.toEqual({
      outcome: "confirmed", journalId: "journal-1"
    });
    expect(f.calls[1]!.sql).toContain("provider_merchant_id=$2 AND e.provider_entity_id=$3");
    expect(f.calls[1]!.values).toEqual([
      input.outboxId, input.merchantId, input.entityId, input.providerReference,
      input.amountMinor, input.currency
    ]);
    expect(f.calls.some(call => call.sql.includes("post_confirmed_merchant_payout"))).toBe(true);
    expect(f.calls.some(call => call.sql === "COMMIT")).toBe(true);
    expect(f.client.release).toHaveBeenCalledTimes(1);
  });

  it("returns the original journal for a repeated verified event", async () => {
    const f = fixture({ duplicate: true });
    await expect(f.store.confirmVerified(input)).resolves.toEqual({
      outcome: "duplicate", journalId: "journal-1"
    });
    expect(f.calls.some(call => call.sql.includes("post_confirmed_merchant_payout"))).toBe(false);
  });

  it("rejects a provider merchant/entity mapping mismatch without posting", async () => {
    const f = fixture({ identity: false });
    await expect(f.store.confirmVerified(input)).rejects.toThrow(
      "MOYASAR_PAYOUT_OUTBOX_OR_MERCHANT_IDENTITY_MISMATCH"
    );
    expect(f.calls.some(call => call.sql.includes("post_confirmed_merchant_payout"))).toBe(false);
    expect(f.calls.some(call => call.sql === "ROLLBACK")).toBe(true);
  });

  it("rejects incomplete provider identity before opening a database transaction", async () => {
    const f = fixture();
    await expect(f.store.confirmVerified({ ...input, entityId: undefined }))
      .rejects.toThrow("INVALID_MOYASAR_MERCHANT_PAYOUT_CONFIRMATION");
    expect(f.calls).toHaveLength(0);
  });
});
