import { describe, expect, it, vi } from "vitest";
import type { PostgresClient, PostgresPool, PostgresQueryResult } from "./postgres-iam-store.js";
import { PostgresCommerceCatalogStore } from "./postgres-commerce-catalog-store.js";
import type { NormalizedCommerceProduct } from "./commerce-connectors.js";

const product: NormalizedCommerceProduct = {
 tenantId:"tenant-a",providerKey:"centrepoint-sa",externalProductId:"sku-1",
 canonicalUrl:"https://www.centrepointstores.com/p/1",title:"Shirt",imageUrls:[],
 variants:[{externalId:"v-1",sizeLabel:"M",availability:"in_stock"}],
 sourceType:"structured_data",sourceCapturedAtUtc:"2026-11-08T10:00:00.000Z",
 sourceContentSha256:"a".repeat(64)
};
function setup(returnId = "product-id") {
 const calls:{sql:string,values?:readonly unknown[]}[]=[];
 const query=vi.fn(async (sql:string,values?:readonly unknown[]):Promise<PostgresQueryResult<any>>=>{
  calls.push({sql,...(values !== undefined ? { values } : {})});
  if(sql.includes("INSERT INTO commerce_catalog_products")) return {rows:returnId?[{id:returnId}]:[],rowCount:returnId?1:0};
  return {rows:[],rowCount:1};
 });
 const client={query,release:vi.fn()} as unknown as PostgresClient;
 const pool={connect:vi.fn(async()=>client),query} as unknown as PostgresPool;
 return {store:new PostgresCommerceCatalogStore(pool),calls,query,client,pool};
}
describe("PostgresCommerceCatalogStore",()=>{
 it("persists product and variants in one transaction",async()=>{
  const x=setup();
  await x.store.upsertPage({tenantId:"tenant-a",integrationId:"int-a",providerKey:"centrepoint-sa",products:[product],capturedAtUtc:"2026-11-08T10:00:00.000Z"});
  expect(x.calls[0]?.sql).toBe("BEGIN");
  expect(x.calls.some(c=>c.sql.includes("INSERT INTO commerce_catalog_products"))).toBe(true);
  expect(x.calls.some(c=>c.sql.includes("INSERT INTO commerce_catalog_variants"))).toBe(true);
  expect(x.calls.at(-1)?.sql).toBe("COMMIT");
  expect(x.client.release).toHaveBeenCalledOnce();
 });
 it("does not overwrite a product when the source snapshot is stale",async()=>{
  const x=setup("");
  await x.store.upsertPage({tenantId:"tenant-a",integrationId:"int-a",providerKey:"centrepoint-sa",products:[product],capturedAtUtc:"2026-11-08T10:00:00.000Z"});
  expect(x.calls.some(c=>c.sql.includes("DELETE FROM commerce_catalog_variants"))).toBe(false);
  expect(x.calls.at(-1)?.sql).toBe("COMMIT");
 });
 it("rolls back the entire page if any variant write fails",async()=>{
  const x=setup();
  x.query.mockImplementation(async(sql:string,values?:readonly unknown[])=>{
   x.calls.push({sql,values});
   if(sql.includes("INSERT INTO commerce_catalog_products")) return {rows:[{id:"product-id"}],rowCount:1};
   if(sql.includes("INSERT INTO commerce_catalog_variants")) throw new Error("db failure");
   return {rows:[],rowCount:1};
  });
  await expect(x.store.upsertPage({tenantId:"tenant-a",integrationId:"int-a",providerKey:"centrepoint-sa",products:[product],capturedAtUtc:"2026-11-08T10:00:00.000Z"})).rejects.toThrow("db failure");
  expect(x.calls.at(-1)?.sql).toBe("ROLLBACK");
  expect(x.client.release).toHaveBeenCalledOnce();
 });
 it("rejects cross-tenant and cross-provider products before acquiring a connection",async()=>{
  const x=setup();
  await expect(x.store.upsertPage({tenantId:"tenant-a",integrationId:"int-a",providerKey:"centrepoint-sa",products:[{...product,tenantId:"tenant-b"}],capturedAtUtc:"2026-11-08T10:00:00.000Z"})).rejects.toThrow("CATALOG_TENANT_OR_PROVIDER_MISMATCH");
  expect(x.pool.connect).not.toHaveBeenCalled();
 });
});
