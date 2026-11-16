import { describe, expect, it } from "vitest";
import { MoyasarPaymentReconciliationClient } from "./moyasar-payment-reconciliation-client.js";

const paymentId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("Moyasar read-only payment reconciliation client", () => {
  it("fetches the payment and returns captured and refunded minor-unit totals", async () => {
    let requestUrl = "";
    let request: RequestInit | undefined;
    const client = new MoyasarPaymentReconciliationClient({
      secretKey: "sk_test_reconciliation123",
      fetchImpl: async (url, init) => {
        requestUrl = String(url);
        request = init;
        return new Response(JSON.stringify({
          id: paymentId, status: "captured", amount: 10000,
          captured: 10000, refunded: 2500, currency: "SAR"
        }), { status: 200 });
      }
    });
    await expect(client.fetchPayment(paymentId)).resolves.toEqual({
      id: paymentId, status: "captured", amountMinor: 10000,
      capturedMinor: 10000, refundedMinor: 2500, currency: "SAR"
    });
    expect(requestUrl).toBe("https://api.moyasar.com/v1/payments/" + paymentId);
    expect(request?.method).toBe("GET");
    expect(new Headers(request?.headers).get("authorization")).toBe(
      "Basic " + Buffer.from("sk_test_reconciliation123:", "utf8").toString("base64")
    );
  });

  it("rejects mismatched identity, invalid totals and malformed responses", async () => {
    const client = new MoyasarPaymentReconciliationClient({
      secretKey: "sk_test_reconciliation123",
      fetchImpl: async () => new Response(JSON.stringify({
        id: paymentId, status: "captured", amount: 10000,
        captured: 10000, refunded: 12000, currency: "SAR"
      }), { status: 200 })
    });
    await expect(client.fetchPayment(paymentId))
      .rejects.toThrow("MOYASAR_PAYMENT_RECONCILIATION_INVALID_RESPONSE");
    await expect(client.fetchPayment("not-a-payment-id"))
      .rejects.toThrow("INVALID_MOYASAR_PAYMENT_ID");
  });

  it("does not turn provider lookup timeouts into an empty or zero refund result", async () => {
    const client = new MoyasarPaymentReconciliationClient({
      secretKey: "sk_test_reconciliation123",
      fetchImpl: async () => { throw new Error("timeout"); }
    });
    await expect(client.fetchPayment(paymentId))
      .rejects.toThrow("MOYASAR_PAYMENT_RECONCILIATION_OUTCOME_UNKNOWN");
  });

  it("allows a paid payment's refunded total to be bounded by its original amount", async () => {
    const client = new MoyasarPaymentReconciliationClient({
      secretKey: "sk_test_reconciliation123",
      fetchImpl: async () => new Response(JSON.stringify({
        id: paymentId, status: "paid", amount: 10000,
        captured: 0, refunded: 2500, currency: "SAR"
      }), { status: 200 })
    });
    await expect(client.fetchPayment(paymentId)).resolves.toMatchObject({
      status: "paid", amountMinor: 10000, capturedMinor: 0, refundedMinor: 2500
    });
  });

  it("rejects a paid payment whose refunded total exceeds its original amount", async () => {
    const client = new MoyasarPaymentReconciliationClient({
      secretKey: "sk_test_reconciliation123",
      fetchImpl: async () => new Response(JSON.stringify({
        id: paymentId, status: "paid", amount: 10000,
        captured: 0, refunded: 12000, currency: "SAR"
      }), { status: 200 })
    });
    await expect(client.fetchPayment(paymentId))
      .rejects.toThrow("MOYASAR_PAYMENT_RECONCILIATION_INVALID_RESPONSE");
  });
});
