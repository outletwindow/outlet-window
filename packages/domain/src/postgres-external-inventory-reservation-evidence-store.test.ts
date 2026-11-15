import { describe, expect, it, vi } from "vitest";
import type { PostgresClient, PostgresPool, PostgresQueryResult } from "./postgres-iam-store.js";
import type { InventoryReservationRequest } from "./inventory-reservation.js";
import { PostgresExternalInventoryReservationEvidenceStore } from "./postgres-external-inventory-reservation-evidence-store.js";

const request: InventoryReservationRequest = {
  tenantId:"merchant-tenant-1",orderId:"order-1",suborderId:"suborder-1",
  merchantId:"merchant-1",branchId:"branch-1",providerIntegrationId:"pos-1",
  idempotencyKey:"paid-checkout:order-1:suborder-1",
  requestedAtUtc:"2026-11-14T12:00:00.000Z",
  lines:[{productVariantId:"catalog-variant-1",sku:"SKU-1",quantity:2}]
};
const evidence = {
  request,providerKey:"pos-acme",providerReservationReference:"external-hold-1",
  expiresAtUtc:"2026-11-14T12:15:00.000Z"
};

function createPool(options: {
  existing?: boolean;
  eligible?: boolean;
  stockMatches?: boolean;
  quantityMatches?: boolean;
  releaseEvidence?: boolean;
  releaseStatus?: string;
  releaseLinesMatch?: boolean;
  releaseSkuMatches?: boolean;
  releaseQuantityMatches?: boolean;
} = {}) {
  const calls: Array<{sql:string;values:readonly unknown[]}> = [];
  const query = vi.fn(async <Row>(sql:string,values:readonly unknown[]=[]):Promise<PostgresQueryResult<Row>> => {
    calls.push({sql,values});
    let rows: unknown[]=[];
    if(sql.includes("FROM inventory_provider_reservation_evidence e")) {
      rows=options.releaseEvidence===false ? [] : [{
        provider_key:"pos-acme",provider_reservation_reference:"external-hold-1",
        status:options.releaseStatus ?? "reserved"
      }];
    } else if(sql.includes("FROM inventory_reservations r")) {
      rows=options.existing ? [{
        id:"local-res-1",tenant_id:request.tenantId,order_id:request.orderId,
        suborder_id:request.suborderId,merchant_id:request.merchantId,branch_id:request.branchId,
        status:"reserved",integration_id:"pos-1",provider_key:"pos-acme",
        provider_reservation_reference:"external-hold-1",expires_at:"2026-11-14T12:15:00.000Z"
      }] : [];
    } else if(sql.includes("FROM inventory_reservations") && sql.includes("FOR UPDATE")) {
      rows=[{id:"local-res-1",status:options.releaseStatus ?? "reserved",expires_at:"2026-11-14T12:15:00.000Z"}];
    } else if(sql.includes("FROM inventory_reservation_lines") && sql.includes("product_variant_id")) {
      rows=[{merchant_id:request.merchantId,branch_id:request.branchId,product_variant_id:"external-variant-1",quantity:2}];
    } else if(sql.includes("FROM inventory_reservation_lines")) {
      rows=[{
        catalog_variant_id:options.releaseLinesMatch === false ? "catalog-variant-other" : "catalog-variant-1",
        sku:options.releaseSkuMatches === false ? "SKU-OTHER" : "SKU-1",
        quantity:options.releaseQuantityMatches === false ? 1 : 2
      }];
    } else if(sql.includes("FROM tenant_integrations i")) {
      rows=options.eligible===false ? [] : [{id:"pos-1"}];
    } else if(sql.includes("FROM merchant_suborders s")) {
      rows=[{id:"suborder-1"}];
    } else if(sql.includes("FROM customer_order_items oi")) {
      rows=options.stockMatches===false ? [] : [{
        catalog_variant_id:"catalog-variant-1",external_variant_id:"external-variant-1",sku:"SKU-1",
        order_quantity:options.quantityMatches===false ? 1 : 2
      }];
    } else if(sql.includes("FROM branch_inventory i")) {
      rows=[{
        product_variant_id:"external-variant-1",available_quantity:8,reserved_quantity:2
      }];
    } else if(sql.startsWith("UPDATE branch_inventory")) {
      return {rows:[],rowCount:1};
    } else if(sql.startsWith("UPDATE inventory_reservations SET status")) {
      return {rows:[],rowCount:1};
    }
    return {rows:rows as Row[],rowCount:rows.length};
  });
  const typedQuery = query as unknown as PostgresClient["query"];
  const client:PostgresClient={query:typedQuery,release:vi.fn()};
  const pool:PostgresPool={query:typedQuery,connect:vi.fn().mockResolvedValue(client)};
  return {pool,client,calls,query};
}

describe("PostgresExternalInventoryReservationEvidenceStore",()=>{
  it("persists the verified provider receipt and exact local reservation atomically",async()=>{
    const db=createPool();
    const store=new PostgresExternalInventoryReservationEvidenceStore(db.pool,()=> "local-res-1");
    await expect(store.record(evidence)).resolves.toEqual({reservationId:"local-res-1",expiresAtUtc:"2026-11-14T12:15:00.000Z"});
    expect(db.calls[0]?.sql).toBe("BEGIN");
    expect(db.calls.some(c=>c.sql.includes("FOR UPDATE OF i,s,m,b"))).toBe(true);
    expect(db.calls.some(c=>c.sql.includes("INSERT INTO inventory_provider_reservation_evidence"))).toBe(true);
    expect(db.calls.some(c=>c.sql.includes("UPDATE branch_inventory"))).toBe(true);
    expect(db.calls.some(c=>c.sql.includes("INSERT INTO inventory_reservation_lines"))).toBe(true);
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("reuses an exact existing reservation on idempotent replay",async()=>{
    const db=createPool({existing:true});
    const store=new PostgresExternalInventoryReservationEvidenceStore(db.pool,()=> "should-not-be-used");
    await expect(store.record(evidence)).resolves.toEqual({reservationId:"local-res-1",expiresAtUtc:"2026-11-14T12:15:00.000Z"});
    expect(db.calls.some(c=>c.sql.includes("INSERT INTO inventory_reservations"))).toBe(false);
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("rejects an idempotent replay when the provider changes the hold expiry",async()=>{
    const db=createPool({existing:true});
    const store=new PostgresExternalInventoryReservationEvidenceStore(db.pool,()=> "unused");
    await expect(store.record({...evidence,expiresAtUtc:"2026-11-14T12:20:00.000Z"}))
      .rejects.toThrow("external_inventory_reservation_idempotency_conflict");
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("rejects a revoked provider scope and rolls back",async()=>{
    const db=createPool({eligible:false});
    const store=new PostgresExternalInventoryReservationEvidenceStore(db.pool,()=> "local-res-1");
    await expect(store.record(evidence)).rejects.toThrow("external_inventory_reservation_scope_revoked");
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("rejects catalog-to-branch SKU mapping drift and rolls back",async()=>{
    const db=createPool({stockMatches:false});
    const store=new PostgresExternalInventoryReservationEvidenceStore(db.pool,()=> "local-res-1");
    await expect(store.record(evidence)).rejects.toThrow("external_inventory_reservation_catalog_mapping_mismatch");
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("rejects a provider reservation quantity that differs from persisted order items",async()=>{
    const db=createPool({quantityMatches:false});
    const store=new PostgresExternalInventoryReservationEvidenceStore(db.pool,()=> "local-res-1");
    await expect(store.record(evidence)).rejects.toThrow("external_inventory_reservation_catalog_mapping_mismatch");
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(db.calls.some(c=>c.sql.includes("INSERT INTO inventory_reservations"))).toBe(false);
  });

  it("rejects malformed external references before opening a database transaction",async()=>{
    const db=createPool();
    const store=new PostgresExternalInventoryReservationEvidenceStore(db.pool,()=> "local-res-1");
    await expect(store.record({...evidence,providerReservationReference:"unsafe\nreference"}))
      .rejects.toThrow("external_inventory_reservation_evidence_invalid");
    expect(db.client.query).not.toHaveBeenCalled();
  });

  it("rejects a non-canonical release timestamp before querying provider evidence",async()=>{
    const db=createPool();
    const store=new PostgresExternalInventoryReservationEvidenceStore(db.pool);
    const releaseProvider=vi.fn();
    await expect(store.release({
      request,reservationId:"local-res-1",releasedAtUtc:"2026-11-14T12:05:00Z"
    },releaseProvider)).resolves.toEqual({outcome:"unsupported"});
    expect(db.query).not.toHaveBeenCalled();
    expect(releaseProvider).not.toHaveBeenCalled();
  });

  it("rejects a release request without its originating integration identity",async()=>{
    const db=createPool();
    const store=new PostgresExternalInventoryReservationEvidenceStore(db.pool);
    const releaseProvider=vi.fn();
    const { providerIntegrationId: _providerIntegrationId, ...requestWithoutIntegration } = request;
    void _providerIntegrationId;
    await expect(store.release({
      request:requestWithoutIntegration,
      reservationId:"local-res-1",releasedAtUtc:"2026-11-14T12:05:00.000Z"
    },releaseProvider)).resolves.toEqual({outcome:"unsupported"});
    expect(db.query).not.toHaveBeenCalled();
    expect(releaseProvider).not.toHaveBeenCalled();
  });

  it("releases the provider hold first and then finalizes the exact local reservation",async()=>{
    const db=createPool();
    const store=new PostgresExternalInventoryReservationEvidenceStore(db.pool);
    const releaseProvider=vi.fn().mockResolvedValue({outcome:"released"});
    await expect(store.release({
      request,reservationId:"local-res-1",releasedAtUtc:"2026-11-14T12:05:00.000Z"
    },releaseProvider)).resolves.toEqual({outcome:"released"});
    expect(releaseProvider).toHaveBeenCalledWith({
      providerKey:"pos-acme",providerReservationReference:"external-hold-1"
    });
    expect(db.calls.some(c=>c.sql.startsWith("UPDATE branch_inventory"))).toBe(true);
    expect(db.calls.some(c=>c.sql.startsWith("UPDATE inventory_reservations"))).toBe(true);
  });

  it("does not call the provider when persisted reservation lines differ from the release request",async()=>{
    const db=createPool({releaseLinesMatch:false});
    const store=new PostgresExternalInventoryReservationEvidenceStore(db.pool);
    const releaseProvider=vi.fn().mockResolvedValue({outcome:"released"});
    await expect(store.release({
      request,reservationId:"local-res-1",releasedAtUtc:"2026-11-14T12:05:00.000Z"
    },releaseProvider)).resolves.toEqual({outcome:"unsupported"});
    expect(releaseProvider).not.toHaveBeenCalled();
    expect(db.calls.some(c=>c.sql.includes("FROM inventory_reservation_lines"))).toBe(true);
    expect(db.calls.some(c=>c.sql.startsWith("UPDATE branch_inventory"))).toBe(false);
  });

  it.each([
    ["SKU", { releaseSkuMatches: false }],
    ["quantity", { releaseQuantityMatches: false }]
  ] as const)("does not call the provider when persisted reservation %s differs from the release request",async(_field,options)=>{
    const db=createPool(options);
    const store=new PostgresExternalInventoryReservationEvidenceStore(db.pool);
    const releaseProvider=vi.fn().mockResolvedValue({outcome:"released"});
    await expect(store.release({
      request,reservationId:"local-res-1",releasedAtUtc:"2026-11-14T12:05:00.000Z"
    },releaseProvider)).resolves.toEqual({outcome:"unsupported"});
    expect(releaseProvider).not.toHaveBeenCalled();
    expect(db.calls.some(c=>c.sql.includes("FROM inventory_reservation_lines"))).toBe(true);
    expect(db.calls.some(c=>c.sql.startsWith("UPDATE branch_inventory"))).toBe(false);
  });

  it("does not change the local ledger when provider release is unsupported",async()=>{
    const db=createPool();
    const store=new PostgresExternalInventoryReservationEvidenceStore(db.pool);
    const releaseProvider=vi.fn().mockResolvedValue({outcome:"unsupported"});
    await expect(store.release({
      request,reservationId:"local-res-1",releasedAtUtc:"2026-11-14T12:05:00.000Z"
    },releaseProvider)).resolves.toEqual({outcome:"unsupported"});
    expect(db.calls.some(c=>c.sql.startsWith("UPDATE branch_inventory"))).toBe(false);
    expect(db.calls.some(c=>c.sql.startsWith("UPDATE inventory_reservations"))).toBe(false);
  });

  it("returns unsupported when the local reservation does not match the originating integration",async()=>{
    const db=createPool({releaseEvidence:false});
    const store=new PostgresExternalInventoryReservationEvidenceStore(db.pool);
    const releaseProvider=vi.fn();
    await expect(store.release({
      request,reservationId:"local-res-1",releasedAtUtc:"2026-11-14T12:05:00.000Z"
    },releaseProvider)).resolves.toEqual({outcome:"unsupported"});
    expect(releaseProvider).not.toHaveBeenCalled();
  });

  it("finishes the local release when the provider confirms the hold was already released",async()=>{
    const db=createPool();
    const store=new PostgresExternalInventoryReservationEvidenceStore(db.pool);
    const releaseProvider=vi.fn().mockResolvedValue({outcome:"already_released"});
    await expect(store.release({
      request,reservationId:"local-res-1",releasedAtUtc:"2026-11-14T12:05:00.000Z"
    },releaseProvider)).resolves.toEqual({outcome:"released"});
    expect(db.calls.some(c=>c.sql.startsWith("UPDATE branch_inventory"))).toBe(true);
    expect(db.calls.some(c=>c.sql.startsWith("UPDATE inventory_reservations SET status"))).toBe(true);
  });

  it("does not call the provider again when the local reservation is already released",async()=>{
    const db=createPool({releaseStatus:"released"});
    const store=new PostgresExternalInventoryReservationEvidenceStore(db.pool);
    const releaseProvider=vi.fn();
    await expect(store.release({
      request,reservationId:"local-res-1",releasedAtUtc:"2026-11-14T12:05:00.000Z"
    },releaseProvider)).resolves.toEqual({outcome:"already_released"});
    expect(releaseProvider).not.toHaveBeenCalled();
    expect(db.calls.some(c=>c.sql.startsWith("UPDATE branch_inventory"))).toBe(false);
    expect(db.calls.some(c=>c.sql.startsWith("UPDATE inventory_reservations SET status"))).toBe(false);
  });

  it("does not call the provider for an expired local reservation",async()=>{
    const db=createPool({releaseStatus:"expired"});
    const store=new PostgresExternalInventoryReservationEvidenceStore(db.pool);
    const releaseProvider=vi.fn();
    await expect(store.release({
      request,reservationId:"local-res-1",releasedAtUtc:"2026-11-14T12:05:00.000Z"
    },releaseProvider)).resolves.toEqual({outcome:"unsupported"});
    expect(releaseProvider).not.toHaveBeenCalled();
    expect(db.calls.some(c=>c.sql.startsWith("UPDATE branch_inventory"))).toBe(false);
  });

  it("never calls the provider for a reservation already consumed locally",async()=>{
    const db=createPool({releaseStatus:"consumed"});
    const store=new PostgresExternalInventoryReservationEvidenceStore(db.pool);
    const releaseProvider=vi.fn();
    await expect(store.release({
      request,reservationId:"local-res-1",releasedAtUtc:"2026-11-14T12:05:00.000Z"
    },releaseProvider)).resolves.toEqual({outcome:"unsupported"});
    expect(releaseProvider).not.toHaveBeenCalled();
    expect(db.calls.some(c=>c.sql.startsWith("UPDATE branch_inventory"))).toBe(false);
  });

  it("leaves the local reservation untouched when the provider release call fails",async()=>{
    const db=createPool();
    const store=new PostgresExternalInventoryReservationEvidenceStore(db.pool);
    const releaseProvider=vi.fn().mockRejectedValue(new Error("provider_timeout"));
    await expect(store.release({
      request,reservationId:"local-res-1",releasedAtUtc:"2026-11-14T12:05:00.000Z"
    },releaseProvider)).rejects.toThrow("provider_timeout");
    expect(db.calls.some(c=>c.sql.startsWith("UPDATE branch_inventory"))).toBe(false);
    expect(db.calls.some(c=>c.sql.startsWith("UPDATE inventory_reservations"))).toBe(false);
  });

});
