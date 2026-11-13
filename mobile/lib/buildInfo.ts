import * as Updates from "expo-updates";
import * as Application from "expo-application";

/**
 * What Profile → About shows, so that "which code did you test?" always has an exact answer.
 *
 * The update ID is the one the Mobile update workflow prints when it publishes. "Built-in code"
 * means no update has been applied: the phone is running what was inside the installed build,
 * which is also what a rollback to the embedded update produces.
 */
export type BuildInfo = { label: string; value: string }[];

type Inputs = {
  appVersion: string | null;
  buildNumber: string | null;
  runtimeVersion: string | null;
  channel: string | null;
  updateId: string | null;
  isEmbeddedLaunch: boolean;
  isEmergencyLaunch: boolean;
  createdAt: Date | null;
  updatesEnabled: boolean;
};

export function describeBuild(i: Inputs): BuildInfo {
  const rows: BuildInfo = [
    { label: "Version", value: `${i.appVersion ?? "?"} (build ${i.buildNumber ?? "?"})` },
    { label: "Runtime", value: i.runtimeVersion ?? "not set" },
    { label: "Channel", value: i.channel ?? (i.updatesEnabled ? "none" : "updates off") },
  ];
  if (i.isEmergencyLaunch) {
    // expo-updates fell back to the built-in code because a downloaded update failed to start.
    rows.push({ label: "Code", value: "Built-in (an update failed to start)" });
  } else if (i.isEmbeddedLaunch || !i.updateId) {
    rows.push({ label: "Code", value: "Built-in" });
  } else {
    rows.push({ label: "Update", value: i.updateId });
    if (i.createdAt) rows.push({ label: "Published", value: i.createdAt.toISOString().slice(0, 16).replace("T", " ") + " UTC" });
  }
  return rows;
}

export function currentBuild(): BuildInfo {
  return describeBuild({
    appVersion: Application.nativeApplicationVersion,
    buildNumber: Application.nativeBuildVersion,
    runtimeVersion: Updates.runtimeVersion,
    channel: Updates.channel,
    updateId: Updates.updateId,
    isEmbeddedLaunch: Updates.isEmbeddedLaunch,
    isEmergencyLaunch: Updates.isEmergencyLaunch,
    createdAt: Updates.createdAt,
    updatesEnabled: Updates.isEnabled,
  });
}
