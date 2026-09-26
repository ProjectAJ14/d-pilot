import { Anchor } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { ApiError } from "./api-client";
import { issueUrl, type Failure } from "./report-issue";

const APP_VERSION =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";

/** issueUrl with the parts every report shares filled in. Call it when the failure happens — it stamps the time. */
export function reportUrl(
  f: Omit<Failure, "version" | "userAgent" | "time">,
): string {
  return issueUrl({
    ...f,
    version: APP_VERSION,
    userAgent: navigator.userAgent,
    time: new Date().toISOString(),
  });
}

/** A 4xx is the server saying no — permissions, validation, the production rails — not a bug. */
export function isReportable(err: unknown): boolean {
  return !(err instanceof ApiError && err.status < 500);
}

/**
 * A caught error as a red toast, with a Report link when it looks like a bug.
 * A 4xx is the server saying no — permissions, validation, the production
 * rails — so there is nothing to report.
 */
export function notifyError(
  err: unknown,
  where: string,
  opts: { title?: string; autoClose?: number } = {},
) {
  const message = err instanceof Error ? err.message : String(err);
  const reportable = isReportable(err);
  const code = (err as { code?: unknown } | null)?.code;
  notifications.show({
    color: "red",
    ...opts,
    message: reportable ? (
      <>
        {message}{" "}
        <Anchor
          href={reportUrl({
            where,
            message,
            code: code == null ? undefined : String(code),
          })}
          target="_blank"
          rel="noopener noreferrer"
          size="xs"
          fw={600}
        >
          Report issue
        </Anchor>
      </>
    ) : (
      message
    ),
  });
}
