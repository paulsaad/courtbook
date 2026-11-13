import { describeBuild } from "../lib/buildInfo";

const base = {
  appVersion: "0.2.0", buildNumber: "7", runtimeVersion: "0.2.0", channel: "preview",
  updateId: null, isEmbeddedLaunch: true, isEmergencyLaunch: false, createdAt: null, updatesEnabled: true,
};

describe("describeBuild", () => {
  it("says built-in code when no update has been applied", () => {
    expect(describeBuild(base)).toContainEqual({ label: "Code", value: "Built-in" });
  });

  it("shows the update ID and publish time once an update is running", () => {
    const rows = describeBuild({ ...base, isEmbeddedLaunch: false, updateId: "0f3c9a1e-1111-2222-3333-444455556666", createdAt: new Date("2026-11-14T09:05:00Z") });
    expect(rows).toContainEqual({ label: "Update", value: "0f3c9a1e-1111-2222-3333-444455556666" });
    expect(rows).toContainEqual({ label: "Published", value: "2026-11-14 09:05 UTC" });
  });

  it("says so when an update failed and the phone fell back to built-in code", () => {
    const rows = describeBuild({ ...base, isEmbeddedLaunch: true, isEmergencyLaunch: true });
    expect(rows).toContainEqual({ label: "Code", value: "Built-in (an update failed to start)" });
  });

  it("shows runtime and channel, the two things an update must match", () => {
    const rows = describeBuild(base);
    expect(rows).toContainEqual({ label: "Runtime", value: "0.2.0" });
    expect(rows).toContainEqual({ label: "Channel", value: "preview" });
  });
});
