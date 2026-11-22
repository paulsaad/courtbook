import { notFound } from "next/navigation";
import { isAdmin, testErrorsAllowed } from "@/lib/monitoringTest";
import MonitoringTest from "./MonitoringTest";

/** Staging only (404 on production and for anyone but an admin): buttons that raise test errors. */
export default async function MonitoringTestPage() {
  if (!testErrorsAllowed() || !(await isAdmin())) notFound();
  return <MonitoringTest environment={process.env.NEXT_PUBLIC_MONITORING_ENV ?? "development"} enabled={!!process.env.NEXT_PUBLIC_SENTRY_DSN} />;
}
