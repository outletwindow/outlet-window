import {describe,expect,it,vi} from "vitest";
import type {PostgresClient,PostgresPool,PostgresQueryResult} from "./postgres-iam-store.js";
import {PostgresCustomerCartStore} from "./postgres-customer-cart-store.js";

function setup() {
 const calls:Array<{sql:string;values?:readonly unknown[]}>=[];
 const query=vi.fn(async(sql:string,values?:readonly unknown[]):Promise<PostgresQueryResult<any>>=>{
  calls.push({sql,...(values===undefined?{}:{values})});
  if(sql.includes("COALESCE(v.currency,p.currency)")) return {rows:[{merchant_tenant_id:"merchant-tenant-1",currency:"SAR",price_minor:"12900"}],rowCount:1};
  if(sql.includes("INSERT INTO customer_carts")) return {rows:[{id:"cart-1",customer_id:"customer-1",currency:"SAR",version:1}],rowCount:1};
  if(sql.includes("DELETE FROM customer_cart_items")) return {rows:[{cart_id:"cart-1"}],rowCount:1};
  if(sql.includes("SELECT quantity FROM customer_cart_items")) return {rows:[],rowCount:0};
  if(sql.includes("SELECT id,customer_id,currency,version FROM customer_carts")) return {rows:[{id:"cart-1",customer_id:"customer-1",currency:"SAR",version:2}],rowCount:1};
  if(sql.includes("FROM customer_cart_items ci")) return {rows:[{id:"item-1",merchant_id:"merchant-1",branch_id:"branch-1",product_variant_id:"variant-1",quantity:2,title:"Shirt",sku:"SKU-1",currency:"SAR",price_minor:"12900",in_stock:true}],rowCount:1};
  return {rows:[],rowCount:1};
 });
 const client={query,release:vi.fn()} as unknown as PostgresClient;
 const pool={query,connect:vi.fn(async()=>client)} as unknown as PostgresPool;
 return {store:new PostgresCustomerCartStore(pool,()=>"generated-id"),calls,query,client};
}
describe("PostgresCustomerCartStore",()=>{
 it("persists a customer-owned branch-scoped item in one transaction and returns its current projection",async()=>{
  const s=setup();
  const cart=await s.store.addItem({customerId:"customer-1",merchantId:"merchant-1",branchId:"branch-1",productVariantId:"variant-1",quantity:2});
  expect(cart).toMatchObject({id:"cart-1",customerId:"customer-1",currency:"SAR",items:[{merchantId:"merchant-1",branchId:"branch-1",quantity:2,priceMinor:12900,inStock:true}]});
  expect(s.calls[0]?.sql).toBe("BEGIN");
  expect(s.calls.some(x=>x.sql.includes("pg_advisory_xact_lock"))).toBe(true);
  expect(s.calls.some(x=>x.sql.includes("p.published_at IS NOT NULL"))).toBe(true);
  expect(s.calls.at(-1)?.sql).toBe("COMMIT");
  expect(s.client.release).toHaveBeenCalledOnce();
 });
 it("rejects invalid quantities before acquiring a connection",async()=>{
  const s=setup();
  await expect(s.store.addItem({customerId:"customer-1",merchantId:"merchant-1",branchId:"branch-1",productVariantId:"variant-1",quantity:100})).rejects.toThrow("invalid_customer_cart_item");
  expect(s.client.release).not.toHaveBeenCalled();
 });
 it("rolls back when a variant is unavailable or not published",async()=>{
  const s=setup();
  s.query.mockImplementation(async(sql:string,values?:readonly unknown[])=>{
   s.calls.push({sql,...(values===undefined?{}:{values})});
   if(sql.includes("SELECT COALESCE(v.currency")) return {rows:[],rowCount:0};
   return {rows:[],rowCount:0};
  });
  await expect(s.store.addItem({customerId:"customer-1",merchantId:"merchant-1",branchId:"branch-1",productVariantId:"variant-1",quantity:1})).rejects.toThrow("customer_cart_variant_unavailable");
  expect(s.calls.at(-1)?.sql).toBe("ROLLBACK");
  expect(s.client.release).toHaveBeenCalledOnce();
 });
 it("scopes item removal to the authenticated customer and active platform cart",async()=>{
  const s=setup();
  await s.store.removeItem({customerId:"customer-1",itemId:"item-other"});
  const deletion=s.calls.find(x=>x.sql.includes("DELETE FROM customer_cart_items"));
  expect(deletion?.sql).toContain("c.customer_id=$3");
  expect(deletion?.values).toEqual(["item-other","platform","customer-1"]);
  expect(s.calls.at(-1)?.sql).toBe("COMMIT");
 });
});
