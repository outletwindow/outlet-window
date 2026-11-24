import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  PostgresPaymentAdjustmentSubmissionOutbox,
  MoyasarPaymentRefundClient,
  MoyasarPaymentAdjustmentProvider,
  createHttpPaymentAdjustmentProvider,
  type PaymentAdjustmentProvider
} from "../../../packages/domain/src/index.js";

const databaseUrl=process.env.DATABASE_URL;
if(!databaseUrl)throw new Error("DATABASE_URL is required; payment adjustment worker will not start");
if(process.env.PAYMENT_ADJUSTMENT_ENVIRONMENT!=="sandbox")
  throw new Error("PAYMENT_ADJUSTMENT_WORKER_SANDBOX_ONLY");
const providerKey: string = process.env.PAYMENT_ADJUSTMENT_PROVIDER_KEY ?? "";
if(!/^[a-zA-Z0-9._-]{1,100}$/.test(providerKey))
  throw new Error("PAYMENT_ADJUSTMENT_PROVIDER_KEY_REQUIRED");
let provider: PaymentAdjustmentProvider;
if(providerKey==="moyasar"){
  const moyasarSecretKey=process.env.MOYASAR_SANDBOX_SECRET_KEY ?? "";
  if(!/^sk_test_[A-Za-z0-9]+$/.test(moyasarSecretKey))
    throw new Error("MOYASAR_TEST_SECRET_KEY_REQUIRED_FOR_SANDBOX_REFUNDS");
  provider=new MoyasarPaymentAdjustmentProvider(
    new MoyasarPaymentRefundClient({secretKey:moyasarSecretKey})
  );
}else{
  const sandboxEndpoint=process.env.PAYMENT_ADJUSTMENT_SANDBOX_ENDPOINT;
  const sandboxToken=process.env.PAYMENT_ADJUSTMENT_SANDBOX_TOKEN;
  if(!sandboxEndpoint||!sandboxToken)throw new Error("PAYMENT_ADJUSTMENT_SANDBOX_CREDENTIALS_REQUIRED");
  provider=createHttpPaymentAdjustmentProvider({
    endpoint:sandboxEndpoint,
    bearerToken:sandboxToken
  });
}
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
            submissionId:job.submissionId,workerId,
            ...(result.providerReference === undefined ? {} : {providerReference:result.providerReference}),
            actorId:"payment-adjustment-worker"
          });
          if(outcome==="conflict"){
            // Provider accepted the request but our durable state no longer matches.
            // Do not retry a money-moving command; require operator reconciliation.
            const quarantined=await store.recordUnknown({
              submissionId:job.submissionId,workerId,
              failureCode:"PAYMENT_ADJUSTMENT_ACCEPTANCE_CONFLICT"
            });
            outcomes[quarantined]=(outcomes[quarantined]??0)+1;
          }else{
            outcomes[outcome]=(outcomes[outcome]??0)+1;
          }
        }else if(result.status==="rejected"){
          const outcome=await store.recordRejected({
            submissionId:job.submissionId,workerId,failureCode:result.code,
            actorId:"payment-adjustment-worker"
          });
          if(outcome==="conflict"){
            const quarantined=await store.recordUnknown({
              submissionId:job.submissionId,workerId,
              failureCode:"PAYMENT_ADJUSTMENT_REJECTION_CONFLICT"
            });
            outcomes[quarantined]=(outcomes[quarantined]??0)+1;
          }else{
            outcomes[outcome]=(outcomes[outcome]??0)+1;
          }
        }else if(result.status==="unknown"){
          const outcome=await store.recordUnknown({
            submissionId:job.submissionId,workerId,failureCode:result.code
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
        // An unexpected exception after submit() may occur after the provider accepted
        // the request. Quarantine it for reconciliation rather than resubmitting.
        const outcome=await store.recordUnknown({
          submissionId:job.submissionId,workerId,failureCode:"PAYMENT_ADJUSTMENT_OUTCOME_UNKNOWN"
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
    "0054_payment_adjustment_provider_reference_uniqueness","0055_payment_adjustment_submission_outbox","0056_payment_adjustment_submission_outbox_guards","0057_payment_adjustment_outcome_reconciliation","0058_payment_adjustment_original_capture_binding",
    "0059_payment_refund_balance_reservations","0061_payment_adjustment_reference_optional",
    "0062_moyasar_single_refund_per_payment","0070_immutable_refund_component_allocations"];
  const migrations=await pool.query("SELECT version FROM schema_migrations WHERE version=ANY($1::text[])",[required]);
  if(migrations.rowCount!==required.length)throw new Error("payment_adjustment_submission_worker_migration_required");
  process.stdout.write(JSON.stringify({
    event:"payment_adjustment_submission_worker_started",workerId,providerKey,
    providerMode:providerKey==="moyasar"?"moyasar_refund_sandbox":"http_sandbox",
    environment:"sandbox",pollMs,batchSize,leaseSeconds
  })+"\n");
  await tick();interval=setInterval(()=>void tick(),pollMs);
}catch(error){await pool.end();throw error;}
