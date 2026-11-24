// The app's `supabase` client, as the test sets it (globalThis.__sb): one signed-in person at a time, like a phone.
export const supabase = new Proxy({}, { get: (_t, k) => { const c = globalThis.__sb; const v = c[k]; return typeof v === "function" ? v.bind(c) : v; } });
