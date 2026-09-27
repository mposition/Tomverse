// The specifier is static; only the quotation marks are different.
export const pauseByTemplate = async () => {
  const store = await import(`@/lib/marketingStore`);
  return store.pauseMarketingChannel;
};
