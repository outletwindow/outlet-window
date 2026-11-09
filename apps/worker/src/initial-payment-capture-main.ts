import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { InitialPaymentCaptureWebhookWorker, PostgresInitialPaymentCaptureInbox } from "../../../packages/domain/src/index.js";

const databaseUrl=process.env.DATABASE_URL;
if(!databaseUrl) throw new Error("DATABASE_URL is required; initial capture worker will not start");
const pollMs=Number.parseInt(process.env.INITIAL_CAPTURE_WORKER_POLL_MS??"1000",10);
const batchSize=Number.parseInt(process.env.INITIAL_CAPTURE_WORKER_BATCH_SIZE??"10",10);
const leaseSeconds=Number.parseInt(process.env.INITIAL_CAPTURE_WORKER_LEASE_SECONDS??"30",10);
if(!Number.isSafeInteger(pollMs)||pollMs<250||pollMs>60_000) throw new Error("INITIAL_CAPTURE_WORKER_POLL_MS must be between 250 and 60000");
if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>100) throw new Error("INITIAL_CAPTURE_WORKER_BATCH_SIZE must be between 1 and 100");
if(!Number.isSafeInteger(leaseSeconds)||leaseSeconds<5||leaseSeconds>300) throw new Error("INITIAL_CAPTURE_WORKER_LEASE_SECONDS must be between 5 and 300");

const pool=new Pool({connectionString:databaseUrl,max:5,connectionTimeoutMillis:5_000,idleTimeoutMillis:30_000,
  ...(process.env.NODE_ENV==="production"?{ssl:{rejectUnauthorized:true}}:{})});
const store=new PostgresInitialPaymentCaptureInbox(pool);
const workerId=randomUUID();
const worker=new InitialPaymentCaptureWebhookWorker(store,workerId,leaseSeconds);
let running=false,stopping=false;
let interval:NodeJS.Timeout|undefined;
async function tick():Promise<void>{
  if(running||stopping)return;
  running=true;
  try{
    const results=[];
    for(let i=0;i<batchSize&&!stopping;i+=1){
      const result=await worker.runOnce();
      if(result.outcome==="idle")break;
      results.push(result);
    }
    if(results.length)process.stdout.write(JSON.stringify({event:"initial_capture_webhook_batch",workerId,
      processed:results.length,outcomes:results.reduce<Record<string,number>>((counts,result)=>{
        counts[result.outcome]=(counts[result.outcome]??0)+1;return counts;
      },{}),occurredAtUtc:new Date().toISOString()})+"\n");
  }catch(error){
    process.stderr.write(JSON.stringify({event:"initial_capture_webhook_worker_error",
      errorCode:error instanceof Error&&/^[A-Za-z0-9_.:-]{1,80}$/.test(error.message)?error.message:"INITIAL_CAPTURE_BATCH_FAILED",
      occurredAtUtc:new Date().toISOString()})+"\n");
  }finally{running=false;}
}
async function shutdown(signal:string):Promise<void>{
  if(stopping)return;stopping=true;if(interval)clearInterval(interval);
  process.stdout.write(JSON.stringify({event:"initial_capture_webhook_worker_stopping",signal})+"\n");
  while(running)await new Promise(resolve=>setTimeout(resolve,50));
  await pool.end();process.exit(0);
}
process.on("SIGINT",()=>void shutdown("SIGINT"));
process.on("SIGTERM",()=>void shutdown("SIGTERM"));
try{
  await pool.query("SELECT 1");
  const migration=await pool.query("SELECT version FROM schema_migrations WHERE version=ANY($1::text[])",[
    ["0027_verified_order_payment_captures","0028_provider_payment_intents","0029_initial_payment_capture_webhook_inbox"]]);
  if(migration.rowCount!==3)throw new Error("initial_capture_webhook_worker_migration_required");
  process.stdout.write(JSON.stringify({event:"initial_capture_webhook_worker_started",pollMs,batchSize,leaseSeconds,workerId})+"\n");
  await tick();interval=setInterval(()=>void tick(),pollMs);
}catch(error){await pool.end();throw error;}
}
