import { Text } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { renderRouter, screen } from "expo-router/testing-library";
import { extractExpoPathFromURL } from "expo-router/build/fork/extractPathFromURL";
// Node's own modules (Jest runs in Node; the app's type settings have no Node types).
declare const require: (m: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
declare const __dirname: string;
const fs = require("fs") as { readdirSync(d: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[] };
const path = require("path") as { join(...p: string[]): string };

/**
 * Booking deep links: courtbook://booking/<id> must open that booking. The app's real route file
 * names are used (a renamed or moved screen breaks this test), with stand-in screens so the test
 * needs no device modules. The screen itself already handles signed-out (sign-in prompt) and
 * someone else's booking ("Booking not found", by row-level security).
 */
const appDir = path.join(__dirname, "..", "app");
const routes = (dir: string, base = ""): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? routes(path.join(dir, e.name), `${base}${e.name}/`) : e.name.endsWith(".tsx") ? [`${base}${e.name.replace(/\.tsx$/, "")}`] : []);

function Shows({ name }: { name: string }) {
  const p = useLocalSearchParams<{ id?: string }>();
  return <Text>{`${name}:${p.id ?? ""}`}</Text>;
}

it("the app has a booking/[id] screen", () => {
  expect(routes(appDir)).toContain("booking/[id]");
});

it("courtbook://booking/<id> is the path /booking/<id>", () => {
  expect(extractExpoPathFromURL(["courtbook"], "courtbook://booking/6f1c2a8e-1111-4111-8111-111111111111")).toBe("booking/6f1c2a8e-1111-4111-8111-111111111111");
});

it("opening /booking/<id> shows the booking screen with that id", async () => {
  // Layouts are left to the router's defaults; every screen is a stand-in that names itself.
  const map = Object.fromEntries(routes(appDir).filter((r) => !r.endsWith("_layout")).map((r) => [r, () => <Shows name={r} />]));
  await renderRouter(map, { initialUrl: "/booking/6f1c2a8e-1111-4111-8111-111111111111" });
  expect(screen.getByText("booking/[id]:6f1c2a8e-1111-4111-8111-111111111111")).toBeTruthy();
});
