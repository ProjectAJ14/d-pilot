import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

/**
 * Point @monaco-editor/react at the *bundled* Monaco instead of its default
 * jsdelivr CDN build.
 *
 * Two reasons this matters:
 *  1. `monaco-vim` imports `monaco-editor/esm/...` at runtime. With the CDN
 *     default the app would end up with TWO Monaco instances — vim's bundled
 *     copy and the CDN copy the user actually types in — so commands vim
 *     constructs (notably ShiftCommand, behind the `>>` / `<<` operators) would
 *     be executed against a foreign instance.
 *  2. The editor no longer needs to reach the public internet at load time,
 *     which matters for restricted/air-gapped deployments.
 *
 * Must be imported before the first <Editor> renders.
 */

declare global {
  // eslint-disable-next-line no-var
  var MonacoEnvironment: monaco.Environment | undefined;
}

// Language services run in web workers. Only `typescript`/`javascript` is
// actually needed beyond the core (the Mongo shell editor uses the JS grammar,
// and its "Format" button routes through the TS worker) — SQL and plaintext
// need no language worker of their own.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });
