export const SIZE_MEASUREMENT_UNITS = ["cm", "in"] as const;
export type SizeMeasurementUnit = (typeof SIZE_MEASUREMENT_UNITS)[number];
export type SizeMeasurementKind = "body" | "garment";

export interface SizeMeasurement {
  key: string;
  label: string;
  value: number;
  unit: SizeMeasurementUnit;
}

export interface ProductSizeEntry {
  sizeLabel: string;
  measurements: readonly SizeMeasurement[];
  availableVariantIds: readonly string[];
}

export interface ProductSizeChart {
  id: string;
  tenantId: string;
  productId: string;
  sourceUrl: string;
  sourceProductReference: string;
  sourceUpdatedAtUtc?: string;
  capturedAtUtc: string;
  measurementKind: SizeMeasurementKind;
  entries: readonly ProductSizeEntry[];
  extractionMethod: "structured_data" | "size_table" | "merchant_api" | "manual_review";
  confidence: number;
  contentSha256: string;
}

export interface SizeChartExtractionInput {
  tenantId: string;
  productId: string;
  sourceUrl: string;
  sourceProductReference: string;
  capturedAtUtc: string;
  measurementKind: SizeMeasurementKind;
  entries: readonly ProductSizeEntry[];
  extractionMethod: ProductSizeChart["extractionMethod"];
  confidence: number;
  contentSha256: string;
}

/** Validate and freeze a source-attributed size chart. Never infer missing measurements or silently mix body and garment measurements. */
export function createProductSizeChart(input: SizeChartExtractionInput): ProductSizeChart {
  const safe = (value: string, max = 240) =>
    typeof value === "string" && value.trim().length > 0 && value.length <= max;
  let source: URL;
  try { source = new URL(input.sourceUrl); } catch { throw new Error("INVALID_SIZE_CHART_SOURCE_URL"); }
  if (source.protocol !== "https:" || source.username || source.password ||
      !safe(input.tenantId) || !safe(input.productId) ||
      !safe(input.sourceProductReference) || !Number.isFinite(Date.parse(input.capturedAtUtc)) ||
      !["body", "garment"].includes(input.measurementKind) ||
      !["structured_data", "size_table", "merchant_api", "manual_review"].includes(input.extractionMethod) ||
      !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1 ||
      !/^[a-f0-9]{64}$/.test(input.contentSha256) ||
      !Array.isArray(input.entries) || input.entries.length === 0 || input.entries.length > 100) {
    throw new Error("INVALID_SIZE_CHART");
  }
  const labels = new Set<string>();
  const entries = input.entries.map(entry => {
    if (!safe(entry.sizeLabel, 40) || labels.has(entry.sizeLabel.toLowerCase()) ||
        !Array.isArray(entry.measurements) || entry.measurements.length === 0 ||
        !Array.isArray(entry.availableVariantIds)) throw new Error("INVALID_SIZE_CHART_ENTRY");
    labels.add(entry.sizeLabel.toLowerCase());
    const keys = new Set<string>();
    const measurements = entry.measurements.map(m => {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(m.key) || !safe(m.label, 80) ||
          keys.has(m.key) || !Number.isFinite(m.value) || m.value <= 0 || m.value > 1000 ||
          !SIZE_MEASUREMENT_UNITS.includes(m.unit)) throw new Error("INVALID_SIZE_MEASUREMENT");
      keys.add(m.key);
      return { ...m };
    });
    if (entry.availableVariantIds.some(id => !safe(id, 160)) ||
        new Set(entry.availableVariantIds).size !== entry.availableVariantIds.length) {
      throw new Error("INVALID_SIZE_VARIANT_REFERENCE");
    }
    return { sizeLabel: entry.sizeLabel, measurements, availableVariantIds: [...entry.availableVariantIds] };
  });
  return {
    id: `sizechart:${input.tenantId}:${input.productId}:${input.contentSha256.slice(0, 16)}`,
    tenantId: input.tenantId, productId: input.productId,
    sourceUrl: source.toString(), sourceProductReference: input.sourceProductReference,
    ...(input.sourceUpdatedAtUtc ? { sourceUpdatedAtUtc: input.sourceUpdatedAtUtc } : {}),
    capturedAtUtc: new Date(input.capturedAtUtc).toISOString(),
    measurementKind: input.measurementKind, entries,
    extractionMethod: input.extractionMethod, confidence: input.confidence,
    contentSha256: input.contentSha256
  };
}

export interface ProductSizeChartSourceAdapter {
  extract(input: {
    productUrl: string;
    productReference: string;
    tenantId: string;
    productId: string;
  }): Promise<SizeChartExtractionInput>;
}

export interface ProductSizeChartStore {
  get(tenantId: string, productId: string): Promise<ProductSizeChart | null>;
  put(chart: ProductSizeChart): Promise<"inserted" | "unchanged" | "updated">;
}
