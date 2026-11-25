// @/lib/report in the local harness: reports are collected (codes only), never sent.
export const reported = (globalThis.__reported ??= []);
export async function report(key, area, detail = {}) { reported.push([key, area, detail]); }
