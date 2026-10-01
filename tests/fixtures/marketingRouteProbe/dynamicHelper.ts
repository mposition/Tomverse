// The specifier is a string in a call rather than an import declaration.
export const pauseDynamically = async () => {
  const store = await import("@/lib/marketingStore");
  return store.pauseMarketingChannel;
};
