// @/lib/payments in the local harness: the provider is the test's fake gateway (globalThis.__provider).
export const getProvider = () => globalThis.__provider;
export const providerNamed = (n) => (globalThis.__provider?.name === n ? globalThis.__provider : null);
