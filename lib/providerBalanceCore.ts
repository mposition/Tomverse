export type ProviderBalanceSnapshot = {
  amount: number;
  currency: string;
  available: boolean | null;
  grantedAmount: number | null;
  toppedUpAmount: number | null;
};

export class ProviderBalanceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderBalanceParseError";
  }
}

const decimalAmount = (value: unknown, path: string) => {
  if (
    typeof value !== "string" ||
    !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())
  ) {
    throw new ProviderBalanceParseError(
      `DeepSeek Balance API returned an invalid amount at ${path}.`
    );
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new ProviderBalanceParseError(
      `DeepSeek Balance API returned an unsupported amount at ${path}.`
    );
  }
  return amount;
};

export const parseDeepSeekBalance = (
  payload: unknown
): ProviderBalanceSnapshot => {
  if (!payload || typeof payload !== "object") {
    throw new ProviderBalanceParseError(
      "DeepSeek Balance API returned an invalid JSON object."
    );
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.is_available !== "boolean") {
    throw new ProviderBalanceParseError(
      "DeepSeek Balance API response omitted is_available."
    );
  }
  if (!Array.isArray(record.balance_infos) || record.balance_infos.length === 0) {
    throw new ProviderBalanceParseError(
      "DeepSeek Balance API response omitted balance_infos."
    );
  }

  const balances = record.balance_infos.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new ProviderBalanceParseError(
        `DeepSeek Balance API returned an invalid balance at balance_infos[${index}].`
      );
    }
    const balance = item as Record<string, unknown>;
    const currency =
      typeof balance.currency === "string"
        ? balance.currency.trim().toUpperCase()
        : "";
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new ProviderBalanceParseError(
        `DeepSeek Balance API returned an invalid currency at balance_infos[${index}].`
      );
    }
    return {
      amount: decimalAmount(
        balance.total_balance,
        `balance_infos[${index}].total_balance`
      ),
      currency,
      grantedAmount: decimalAmount(
        balance.granted_balance,
        `balance_infos[${index}].granted_balance`
      ),
      toppedUpAmount: decimalAmount(
        balance.topped_up_balance,
        `balance_infos[${index}].topped_up_balance`
      ),
    };
  });
  const preferred =
    balances.find((balance) => balance.currency === "USD") ||
    balances.find((balance) => balance.currency === "CNY") ||
    balances[0];

  return {
    ...preferred,
    available: record.is_available,
  };
};
