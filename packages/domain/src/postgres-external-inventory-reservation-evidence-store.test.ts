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
} = {}) {
  const calls: Array<{sql:string;values:readonly unknown[]}> = [];
  const query = vi.fn(async <Row>(sql:string,values:readonly unknown[]=[]):Promise<PostgresQueryResult<Row>> => {
    calls.push({sql,values});
    let rows: unknown[]=[];
    if(sql.includes("FROM inventory_reservations r")) {
      rows=options.existing ? [{
        id:"local-res-1",tenant_id:request.tenantId,order_id:request.orderId,
        suborder_id:request.suborderId,merchant_id:request.merchantId,branch_id:request.branchId,
        status:"reserved",integration_id:"pos-1",provider_key:"pos-acme",
        provider_reservation_reference:"external-hold-1"
      }] : [];
    } else if(sql.includes("FROM inventory_reservation_lines")) {
      rows=[{catalog_variant_id:"catalog-variant-1",sku:"SKU-1",quantity:2}];
    } else if(sql.includes("FROM tenant_integrations i")) {
      rows=options.eligible===false ? [] : [{id:"pos-1"}];
    } else if(sql.includes("FROM merchant_suborders s")) {
      rows=[{id:"suborder-1"}];
    } else if(sql.includes("FROM customer_order_items oi")) {
      rows=options.stockMatches===false ? [] : [{
        catalog_variant_id:"catalog-variant-1",external_variant_id:"external-variant-1",sku:"SKU-1",
        order_quantity:options.quantityMatches===false ? 1 : 2
      }];
    } else if(sql.includes("UPDATE branch_inventory")) {
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
    await expect(store.record(evidence)).resolves.toEqual({reservationId:"local-res-1"});
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
    await expect(store.record(evidence)).resolves.toEqual({reservationId:"local-res-1"});
    expect(db.calls.some(c=>c.sql.includes("INSERT INTO inventory_reservations"))).toBe(false);
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
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
});
