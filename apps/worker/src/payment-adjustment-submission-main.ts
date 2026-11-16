import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  PostgresPaymentAdjustmentSubmissionOutbox,
  createHttpPaymentAdjustmentProvider
} from "../../../packages/domain/src/index.js";

const databaseUrl=process.env.DATABASE_URL;
if(!databaseUrl)throw new Error("DATABASE_URL is required; payment adjustment worker will not start");
if(process.env.PAYMENT_ADJUSTMENT_ENVIRONMENT!=="sandbox")
  throw new Error("PAYMENT_ADJUSTMENT_WORKER_SANDBOX_ONLY");
const providerKey=process.env.PAYMENT_ADJUSTMENT_PROVIDER_KEY;
if(!providerKey||!/^[a-zA-Z0-9._-]{1,100}$/.test(providerKey))
  throw new Error("PAYMENT_ADJUSTMENT_PROVIDER_KEY_REQUIRED");
const provider=createHttpPaymentAdjustmentProvider({
  endpoint:process.env.PAYMENT_ADJUSTMENT_SANDBOX_ENDPOINT,
  bearerToken:process.env.PAYMENT_ADJUSTMENT_SANDBOX_TOKEN
});
const pollMs=Number.parseInt(process.env.PAYMENT_ADJUSTMENT_WORKER_POLL_MS??"1000",10);
const batchSize=Number.parseInt(process.env.PAYMENT_ADJUSTMENT_WORKER_BATCH_SIZE??"5",10);
const leaseSeconds=Number.parseInt(process.env.PAYMENT_ADJUSTMENT_WORKER_LEASE_SECONDS??"60",10);
if(!Number.isSafeInteger(pollMs)||pollMs<250||pollMs>60_000)throw new Error("PAYMENT_ADJUSTMENT_WORKER_POLL_MS_INVALID");
if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>50)throw new Error("PAYMENT_ADJUSTMENT_WORKER_BATCH_SIZE_INVALID");
if(!Number.isSafeInteger(leaseSeconds)||leaseSeconds<10||leaseSeconds>300)throw new Error("PAYMENT_ADJUSTMENT_WORKER_LEASE_SECONDS_INVALID");

const pool=new Pool({connectionString:databaseUrl,max:5,connectionTimeoutMillis:5_000,idleTimeoutMillis:30_000,
  ...(process.env.NODE_ENV==="production"?{ssl:{rejectUnauthorized:true}}:{})});
const store=new PostgresPaymentAdjustmentSubmissionOutbox(pool);
const workerId=randomUUID();
let running=false,stopping=false;
let interval:NodeJS.Timeout|undefined;

async function tick():Promise<void>{
  if(running||stopping)return;
  running=true;
  try{
    const outcomes:Record<string,number>={};
    for(let i=0;i<batchSize&&!stopping;i+=1){
      const job=await store.claimNext(workerId,providerKey,leaseSeconds);
      if(!job)break;
      try{
        const result=await provider.submit(job.command);
        if(result.status==="accepted"){
          const outcome=await store.recordAccepted({
            submissionId:job.submissionId,workerId,providerReference:result.providerReference,
            actorId:"payment-adjustment-worker"
          });
          outcomes[outcome]=(outcomes[outcome]??0)+1;
        }else if(result.status==="rejected"){
          const outcome=await store.recordRejected({
            submissionId:job.submissionId,workerId,failureCode:result.code,
            actorId:"payment-adjustment-worker"
          });
          outcomes[outcome]=(outcomes[outcome]??0)+1;
        }else{
          const delaySeconds=Math.min(3600,Math.max(5,2**Math.min(job.attemptCount,10)));
          const outcome=await store.retry({
            submissionId:job.submissionId,workerId,failureCode:result.code,delaySeconds
          });
          outcomes[outcome]=(outcomes[outcome]??0)+1;
        }
      }catch{
        const delaySeconds=Math.min(3600,Math.max(5,2**Math.min(job.attemptCount,10)));
        const outcome=await store.retry({
          submissionId:job.submissionId,workerId,failureCode:"PAYMENT_ADJUSTMENT_WORKER_ERROR",delaySeconds
        }).catch(()=> "lease_lost" as const);
        outcomes[outcome]=(outcomes[outcome]??0)+1;
      }
    }
    if(Object.keys(outcomes).length)process.stdout.write(JSON.stringify({
      event:"payment_adjustment_submission_batch",workerId,providerKey,outcomes,
      occurredAtUtc:new Date().toISOString()
    })+"\n");
  }catch(error){
    process.stderr.write(JSON.stringify({
      event:"payment_adjustment_submission_worker_error",
      errorCode:error instanceof Error&&/^[A-Za-z0-9_.:-]{1,100}$/.test(error.message)
        ?error.message:"PAYMENT_ADJUSTMENT_BATCH_FAILED",
      occurredAtUtc:new Date().toISOString()
    })+"\n");
  }finally{running=false;}
}

async function shutdown(signal:string):Promise<void>{
  if(stopping)return;stopping=true;if(interval)clearInterval(interval);
  process.stdout.write(JSON.stringify({event:"payment_adjustment_submission_worker_stopping",signal})+"\n");
  while(running)await new Promise(resolve=>setTimeout(resolve,50));
  await pool.end();process.exit(0);
}
process.on("SIGINT",()=>void shutdown("SIGINT"));
process.on("SIGTERM",()=>void shutdown("SIGTERM"));

try{
  await pool.query("SELECT 1");
  const required=["0013_payment_adjustment_consents","0052_payment_adjustment_provider_binding",
    "0054_payment_adjustment_provider_reference_uniqueness","0055_payment_adjustment_submission_outbox"];
  const migrations=await pool.query("SELECT version FROM schema_migrations WHERE version=ANY($1::text[])",[required]);
  if(migrations.rowCount!==required.length)throw new Error("payment_adjustment_submission_worker_migration_required");
  process.stdout.write(JSON.stringify({
    event:"payment_adjustment_submission_worker_started",workerId,providerKey,
    environment:"sandbox",pollMs,batchSize,leaseSeconds
  })+"\n");
  await tick();interval=setInterval(()=>void tick(),pollMs);
}catch(error){await pool.end();throw error;}
