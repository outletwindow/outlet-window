import { describe, expect, it } from "vitest";
import { createProductSizeChart } from "./product-size-chart.js";

const input = {
  tenantId: "tenant-1", productId: "product-1",
  sourceUrl: "https://shop.example/products/shirt",
  sourceProductReference: "shirt-001",
  capturedAtUtc: "2026-11-08T10:00:00.000Z",
  measurementKind: "garment" as const,
  entries: [{
    sizeLabel: "M",
    measurements: [
      { key: "chest", label: "Chest", value: 52, unit: "cm" as const },
      { key: "length", label: "Length", value: 70, unit: "cm" as const }
    ],
    availableVariantIds: ["variant-m"]
  }],
  extractionMethod: "size_table" as const,
  confidence: 0.98,
  contentSha256: "a".repeat(64)
};

describe("product size chart", () => {
  it("stores source-attributed size entries and measurement type", () => {
    expect(createProductSizeChart(input)).toMatchObject({
      tenantId: "tenant-1", productId: "product-1",
      measurementKind: "garment", sourceUrl: input.sourceUrl,
      entries: [{ sizeLabel: "M", measurements: [{ key: "chest", value: 52, unit: "cm" }] }]
    });
  });
  it("rejects insecure source URLs and mixed or invalid measurements", () => {
    expect(() => createProductSizeChart({ ...input, sourceUrl: "http://shop.example/item" }))
      .toThrow("INVALID_SIZE_CHART");
    expect(() => createProductSizeChart({
      ...input, entries: [{ ...input.entries[0], measurements: [{ key: "chest", label: "Chest", value: -1, unit: "cm" }] }]
    })).toThrow("INVALID_SIZE_MEASUREMENT");
  });
  it("rejects duplicate size labels", () => {
    expect(() => createProductSizeChart({
      ...input, entries: [input.entries[0], input.entries[0]]
    })).toThrow("INVALID_SIZE_CHART_ENTRY");
  });
});
