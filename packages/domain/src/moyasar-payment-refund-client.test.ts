import { describe, expect, it } from "vitest";
import { MoyasarPaymentRefundClient } from "./moyasar-payment-refund-client.js";

const paymentId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const secretKey = "sk_test_refundclient123";

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: paymentId, status: "captured", amount: 10_000,
    captured: 10_000, refunded: 1_000, currency: "SAR", ...overrides
  };
}

describe("Moyasar one-shot payment refund client", () => {
  it("checks the existing payment and submits one partial refund without claiming provider idempotency", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new MoyasarPaymentRefundClient({
      secretKey,
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        if (init?.method === "GET") return new Response(JSON.stringify(payment()), { status: 200 });
        return new Response(JSON.stringify(payment({ status: "captured", refunded: 3_500 })), { status: 200 });
      }
    });

    await expect(client.refund({
      paymentId, amountMinor: 2_500, currency: "SAR", expectedRefundedMinor: 1_000
    })).resolves.toMatchObject({
      outcome: "confirmed",
      refundedThisAttemptMinor: 2_500,
      payment: { id: paymentId, refundedMinor: 3_500, currency: "SAR" }
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.init?.method).toBe("GET");
    expect(requests[1]?.url).toBe(`https://api.moyasar.com/v1/payments/${paymentId}/refund`);
    expect(requests[1]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ amount: 2_500 });
    const headers = new Headers(requests[1]?.init?.headers);
    expect(headers.get("authorization")).toBe(
      "Basic " + Buffer.from(`${secretKey}:`, "utf8").toString("base64")
    );
    expect(headers.has("idempotency-key")).toBe(false);
  });

  it("uses the payment amount as the refundable base for paid payments", async () => {
    let postCount = 0;
    const client = new MoyasarPaymentRefundClient({
      secretKey,
      fetchImpl: async (_url, init) => {
        if (init?.method === "GET") {
          return new Response(JSON.stringify(payment({
            status: "paid", captured: 0, refunded: 1_000
          })), { status: 200 });
        }
        postCount += 1;
        return new Response(JSON.stringify(payment({
          status: "refunded", captured: 0, refunded: 10_000
        })), { status: 200 });
      }
    });
    await expect(client.refund({
      paymentId, amountMinor: 9_000, currency: "SAR", expectedRefundedMinor: 1_000
    })).resolves.toMatchObject({ outcome: "confirmed", payment: { refundedMinor: 10_000 } });
    expect(postCount).toBe(1);
  });

  it("does not submit when the expected refunded total is stale or currency/status differs", async () => {
    let postCount = 0;
    const client = new MoyasarPaymentRefundClient({
      secretKey,
      fetchImpl: async (_url, init) => {
        if (init?.method === "POST") postCount += 1;
        return new Response(JSON.stringify(payment({ refunded: 2_000 })), { status: 200 });
      }
    });
    await expect(client.refund({
      paymentId, amountMinor: 1_000, currency: "SAR", expectedRefundedMinor: 1_000
    })).resolves.toEqual({ outcome: "rejected", code: "MOYASAR_REFUND_PRECONDITION_CONFLICT" });
    expect(postCount).toBe(0);
  });

  it("rejects a refund larger than the remaining captured amount without submitting", async () => {
    let postCount = 0;
    const client = new MoyasarPaymentRefundClient({
      secretKey,
      fetchImpl: async (_url, init) => {
        if (init?.method === "POST") postCount += 1;
        return new Response(JSON.stringify(payment({ captured: 5_000, refunded: 4_000 })), { status: 200 });
      }
    });
    await expect(client.refund({
      paymentId, amountMinor: 1_001, currency: "SAR", expectedRefundedMinor: 4_000
    })).resolves.toEqual({ outcome: "rejected", code: "MOYASAR_REFUND_EXCEEDS_REMAINING_AMOUNT" });
    expect(postCount).toBe(0);
  });

  it("quarantines a network failure after the refund request may have been sent", async () => {
    let calls = 0;
    const client = new MoyasarPaymentRefundClient({
      secretKey,
      fetchImpl: async (_url, init) => {
        calls += 1;
        if (init?.method === "GET") return new Response(JSON.stringify(payment()), { status: 200 });
        throw new Error("connection closed after write");
      }
    });
    await expect(client.refund({
      paymentId, amountMinor: 2_500, currency: "SAR", expectedRefundedMinor: 1_000
    })).resolves.toEqual({ outcome: "unknown", code: "MOYASAR_REFUND_OUTCOME_UNKNOWN" });
    expect(calls).toBe(2);
  });

  it("treats 429 and 5xx as unknown and never retries the refund", async () => {
    for (const status of [429, 500, 503]) {
      let posts = 0;
      const client = new MoyasarPaymentRefundClient({
        secretKey,
        fetchImpl: async (_url, init) => {
          if (init?.method === "GET") return new Response(JSON.stringify(payment()), { status: 200 });
          posts += 1;
          return new Response("{}", { status });
        }
      });
      await expect(client.refund({
        paymentId, amountMinor: 2_500, currency: "SAR", expectedRefundedMinor: 1_000
      })).resolves.toMatchObject({ outcome: "unknown", code: "MOYASAR_REFUND_OUTCOME_UNKNOWN" });
      expect(posts).toBe(1);
    }
  });

  it("does not confirm a successful HTTP response unless the cumulative refunded total matches exactly", async () => {
    const client = new MoyasarPaymentRefundClient({
      secretKey,
      fetchImpl: async (_url, init) => init?.method === "GET"
        ? new Response(JSON.stringify(payment()), { status: 200 })
        : new Response(JSON.stringify(payment({ refunded: 3_499 })), { status: 200 })
    });
    await expect(client.refund({
      paymentId, amountMinor: 2_500, currency: "SAR", expectedRefundedMinor: 1_000
    })).resolves.toEqual({ outcome: "unknown", code: "MOYASAR_REFUND_RESPONSE_UNVERIFIABLE" });
  });

  it("rejects malformed identifiers and never performs a request", async () => {
    let calls = 0;
    const client = new MoyasarPaymentRefundClient({
      secretKey, fetchImpl: async () => { calls += 1; return new Response("{}", { status: 200 }); }
    });
    await expect(client.refund({
      paymentId: "not-a-uuid", amountMinor: 100, currency: "SAR", expectedRefundedMinor: 0
    })).resolves.toEqual({ outcome: "rejected", code: "INVALID_MOYASAR_REFUND_COMMAND" });
    expect(calls).toBe(0);
  });

  it("does not submit another refund when Moyasar reports refunded status", async () => {
    let postCount = 0;
    const client = new MoyasarPaymentRefundClient({
      secretKey,
      fetchImpl: async (_url, init) => {
        if (init?.method === "POST") postCount += 1;
        return new Response(JSON.stringify(payment({
          status: "refunded", captured: 10_000, refunded: 3_500
        })), { status: 200 });
      }
    });
    await expect(client.refund({
      paymentId, amountMinor: 2_500, currency: "SAR", expectedRefundedMinor: 3_500
    })).resolves.toEqual({
      outcome: "rejected", code: "MOYASAR_REFUND_PRECONDITION_CONFLICT"
    });
    expect(postCount).toBe(0);
  });
});
