"use client";

/** Last resort when even the page frame could not load (W1, audit B2). Plain markup: the app's styles may be missing. */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "64px 24px", textAlign: "center", color: "#121614", background: "#f6f6f4" }}>
        <h1 style={{ fontSize: 20 }}>Couldn&apos;t load CourtBook</h1>
        <p style={{ color: "#6b7270" }}>Check your connection and try again.</p>
        <button type="button" onClick={() => reset()}
          style={{ minHeight: 44, padding: "12px 20px", borderRadius: 12, border: 0, background: "#0f7a47", color: "#fff", fontSize: 16 }}>Try again</button>
      </body>
    </html>
  );
}
