/**
 * Trigger a browser download of in-memory text content.
 *
 * The anchor is attached to the document and the object URL is revoked on a
 * delay — revoking synchronously after click() can abort the download in
 * Safari/older Firefox.
 */
export function downloadTextFile(
  filename: string,
  content: string,
  mimeType = "text/csv",
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
