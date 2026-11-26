/**
 * Normalise a phone number to E.164 digits for wa.me links. Lebanese local numbers
 * ("03 123 456", "70 123 456", "01 234 567") become +961…; international input
 * ("+961 3 123 456", "0049 7633 50623") is kept as given. Returns null when invalid.
 */
export function normalizePhone(raw: string): string | null {
  const s = raw.trim().replace(/[\s().-]/g, "");
  if (!s) return null;
  let digits: string;
  if (s.startsWith("+")) digits = s.slice(1);
  else if (s.startsWith("00")) digits = s.slice(2);
  else if (s.startsWith("961")) digits = s;
  else if (/^0\d{7}$/.test(s)) digits = "961" + s.slice(1);          // Lebanese local: 0X XXX XXX (mobile or landline)
  else if (/^0\d{8}$/.test(s)) digits = "961" + s.slice(1);          // some 9-digit local formats
  else if (/^[378]\d{7}$/.test(s)) digits = "961" + s;               // mobile without the leading 0: 70 123 456, 81 …, 3x …
  else if (/^3\d{6}$/.test(s)) digits = "961" + s;                   // 3 123 456 (03 without the 0)
  else return null;
  if (!/^\d{8,15}$/.test(digits)) return null;
  return "+" + digits;
}

export function waNumber(e164: string): string {
  return e164.replace(/[^\d]/g, "");
}
