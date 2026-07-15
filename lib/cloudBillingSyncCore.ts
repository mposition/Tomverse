import { createHash, createHmac } from "node:crypto";

export class CloudBillingParseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CloudBillingParseError";
    this.code = code;
  }
}

const signedDecimal = (value: unknown, path: string) => {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(
      String(value).trim()
    )
  ) {
    throw new CloudBillingParseError(
      "CLOUD_BILLING_INVALID_AMOUNT",
      `Billing API returned an invalid amount at ${path}.`
    );
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CloudBillingParseError(
      "CLOUD_BILLING_INVALID_AMOUNT",
      `Billing API returned an unsupported amount at ${path}.`
    );
  }
  return parsed;
};

export const validateGoogleBillingExportTable = (value: string) => {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new CloudBillingParseError(
      "GOOGLE_BILLING_EXPORT_TABLE_INVALID",
      "GOOGLE_CLOUD_BILLING_EXPORT_TABLE must be a full project.dataset.table identifier."
    );
  }
  return normalized;
};

export const googleCloudBillingQuery = (table: string) => {
  const safeTable = validateGoogleBillingExportTable(table);
  return `SELECT CAST(ROUND(COALESCE(SUM(SAFE_DIVIDE(cost + IFNULL((SELECT SUM(credit.amount) FROM UNNEST(credits) AS credit), 0), currency_conversion_rate)), 0) * 1000000) AS INT64) AS cost_micro_usd, COUNT(1) AS row_count, COUNTIF(currency_conversion_rate IS NULL OR currency_conversion_rate = 0) AS invalid_currency_rate_rows FROM \`${safeTable}\` WHERE DATE(usage_start_time) = @usage_date`;
};

export const googleCloudBillingQueryRequest = (
  table: string,
  date: Date,
  location?: string
) => ({
  query: googleCloudBillingQuery(table),
  useLegacySql: false,
  parameterMode: "NAMED",
  timeoutMs: 20_000,
  ...(location ? { location } : {}),
  queryParameters: [
    {
      name: "usage_date",
      parameterType: { type: "DATE" },
      parameterValue: { value: date.toISOString().slice(0, 10) },
    },
  ],
});

export const parseGoogleCloudBillingQuery = (payload: unknown) => {
  if (!payload || typeof payload !== "object") {
    throw new CloudBillingParseError(
      "GOOGLE_BILLING_INVALID_PAYLOAD",
      "Google BigQuery returned an invalid JSON object."
    );
  }
  const record = payload as Record<string, unknown>;
  if (record.jobComplete !== true) {
    throw new CloudBillingParseError(
      "GOOGLE_BILLING_JOB_INCOMPLETE",
      "Google BigQuery billing query did not complete within the bounded request."
    );
  }
  if (!Array.isArray(record.rows) || record.rows.length !== 1) {
    throw new CloudBillingParseError(
      "GOOGLE_BILLING_INVALID_PAYLOAD",
      "Google BigQuery billing query did not return exactly one summary row."
    );
  }
  const row = record.rows[0];
  const fields =
    row && typeof row === "object"
      ? (row as Record<string, unknown>).f
      : null;
  if (!Array.isArray(fields) || fields.length < 3) {
    throw new CloudBillingParseError(
      "GOOGLE_BILLING_INVALID_PAYLOAD",
      "Google BigQuery billing summary row omitted expected fields."
    );
  }
  const fieldValue = (index: number) => {
    const field = fields[index];
    return field && typeof field === "object"
      ? (field as Record<string, unknown>).v
      : undefined;
  };
  const costMicroUsd = signedDecimal(fieldValue(0), "rows[0].f[0].v");
  const rowCount = signedDecimal(fieldValue(1), "rows[0].f[1].v");
  const invalidCurrencyRateRows = signedDecimal(
    fieldValue(2),
    "rows[0].f[2].v"
  );
  if (
    !Number.isSafeInteger(costMicroUsd) ||
    !Number.isSafeInteger(rowCount) ||
    rowCount < 0 ||
    !Number.isSafeInteger(invalidCurrencyRateRows) ||
    invalidCurrencyRateRows < 0
  ) {
    throw new CloudBillingParseError(
      "GOOGLE_BILLING_INVALID_AMOUNT",
      "Google BigQuery returned a billing total outside the supported integer range."
    );
  }
  if (invalidCurrencyRateRows > 0) {
    throw new CloudBillingParseError(
      "GOOGLE_BILLING_INVALID_EXCHANGE_RATE",
      "Google Cloud Billing export contained rows without a valid currency conversion rate."
    );
  }
  return { costMicroUsd, rowCount, invalidCurrencyRateRows };
};

const sha256Hex = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const percentEncode = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );

export const createAlibabaCloudBillingRequest = ({
  endpoint,
  accessKeyId,
  accessKeySecret,
  securityToken,
  date,
  pageNumber,
  pageSize = 300,
  productCode,
  now = new Date(),
  nonce,
}: {
  endpoint: string;
  accessKeyId: string;
  accessKeySecret: string;
  securityToken?: string;
  date: Date;
  pageNumber: number;
  pageSize?: number;
  productCode?: string;
  now?: Date;
  nonce: string;
}) => {
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
    throw new CloudBillingParseError(
      "ALIBABA_BILLING_PAGE_INVALID",
      "Alibaba Cloud billing page number is invalid."
    );
  }
  const endpointUrl = new URL(
    endpoint.includes("://") ? endpoint : `https://${endpoint}`
  );
  if (endpointUrl.protocol !== "https:" || endpointUrl.pathname !== "/") {
    throw new CloudBillingParseError(
      "ALIBABA_BILLING_ENDPOINT_INVALID",
      "ALIBABA_CLOUD_BILLING_ENDPOINT must be an HTTPS origin without a path."
    );
  }
  const dateText = date.toISOString().slice(0, 10);
  const query: Record<string, string> = {
    BillingCycle: dateText.slice(0, 7),
    Granularity: "DAILY",
    BillingDate: dateText,
    PageNum: String(pageNumber),
    PageSize: String(pageSize),
    IsHideZeroCharge: "true",
    ...(productCode ? { ProductCode: productCode } : {}),
  };
  const canonicalQuery = Object.entries(query)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`)
    .join("&");
  const body = "";
  const payloadHash = sha256Hex(body);
  const headers: Record<string, string> = {
    host: endpointUrl.host,
    "x-acs-action": "QueryInstanceBill",
    "x-acs-content-sha256": payloadHash,
    "x-acs-date": now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    "x-acs-signature-nonce": nonce,
    "x-acs-version": "2017-12-14",
    ...(securityToken ? { "x-acs-security-token": securityToken } : {}),
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.entries(headers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value.trim()}\n`)
    .join("");
  const canonicalRequest = [
    "POST",
    "/",
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = `ACS3-HMAC-SHA256\n${sha256Hex(canonicalRequest)}`;
  const signature = createHmac("sha256", accessKeySecret)
    .update(stringToSign, "utf8")
    .digest("hex");
  headers.Authorization = `ACS3-HMAC-SHA256 Credential=${accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
  endpointUrl.search = canonicalQuery;

  return {
    url: endpointUrl.toString(),
    headers,
    body,
    canonicalRequest,
  };
};

export const parseAlibabaCloudBillingPage = (payload: unknown) => {
  if (!payload || typeof payload !== "object") {
    throw new CloudBillingParseError(
      "ALIBABA_BILLING_INVALID_PAYLOAD",
      "Alibaba Cloud Billing returned an invalid JSON object."
    );
  }
  const record = payload as Record<string, unknown>;
  const data = record.Data;
  if (!data || typeof data !== "object") {
    throw new CloudBillingParseError(
      "ALIBABA_BILLING_INVALID_PAYLOAD",
      "Alibaba Cloud Billing response omitted Data."
    );
  }
  const dataRecord = data as Record<string, unknown>;
  const itemsContainer = dataRecord.Items;
  const rawItems =
    itemsContainer && typeof itemsContainer === "object"
      ? (itemsContainer as Record<string, unknown>).Item
      : undefined;
  const items = rawItems === undefined ? [] : Array.isArray(rawItems) ? rawItems : [rawItems];
  const totalCount = signedDecimal(dataRecord.TotalCount ?? 0, "Data.TotalCount");
  if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
    throw new CloudBillingParseError(
      "ALIBABA_BILLING_INVALID_PAYLOAD",
      "Alibaba Cloud Billing returned an invalid TotalCount."
    );
  }

  let costUsd = 0;
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object") {
      throw new CloudBillingParseError(
        "ALIBABA_BILLING_INVALID_PAYLOAD",
        `Alibaba Cloud Billing returned an invalid item at Data.Items.Item[${index}].`
      );
    }
    const itemRecord = item as Record<string, unknown>;
    const currency =
      typeof itemRecord.Currency === "string"
        ? itemRecord.Currency.trim().toUpperCase()
        : "";
    if (currency !== "USD") {
      throw new CloudBillingParseError(
        "ALIBABA_BILLING_NON_USD",
        `Alibaba Cloud Billing returned ${currency || "an unknown currency"}; exact micro-USD reconciliation requires an international USD billing account.`
      );
    }
    costUsd += signedDecimal(
      itemRecord.PretaxAmount,
      `Data.Items.Item[${index}].PretaxAmount`
    );
  }
  if (!Number.isFinite(costUsd)) {
    throw new CloudBillingParseError(
      "ALIBABA_BILLING_INVALID_AMOUNT",
      "Alibaba Cloud Billing returned a total outside the supported numeric range."
    );
  }
  return {
    costUsd,
    itemCount: items.length,
    totalCount,
    requestId:
      typeof record.RequestId === "string" ? record.RequestId.slice(0, 160) : null,
  };
};
