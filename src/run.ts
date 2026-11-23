import { spawn } from "node:child_process";
import type { Unowned } from "./hosts";
import { startServer, type ServerOptions } from "./server";

/**
 * `terrarium run "<command>"`: a command, such as an app's dev server or its tests, inside the sandbox. Its Node processes are preloaded with `@saeris/terrarium/register` and pointed at the sandbox, so they reach it at the network's own addresses. A sandbox already running at `url` is used and left running; otherwise one is started for the command and stopped when it ends.
 */

export interface RunOptions extends ServerOptions {
  /** The command, as a shell runs it. */
  readonly command: string;
  /** Where a running sandbox's control API would be. */
  readonly url: string;
  /** What the command's requests to addresses the sandbox doesn't own do: as `TERRARIUM_UNOWNED`. */
  readonly unowned?: Unowned | undefined;
  /** The preload, built beside this module. */
  readonly register?: URL;
}

const isRunning = async (url: string): Promise<boolean> => {
  try {
    return (await fetch(`${url}/health`)).ok;
  } catch {
    return false;
  }
};

/** Run the command; resolves with its exit code. */
export const run = async ({
  command,
  url,
  unowned,
  register = new URL("./register.mjs", import.meta.url),
  ...options
}: RunOptions): Promise<number> => {
  const started = (await isRunning(url))
    ? undefined
    : await startServer(options);
  const control = started?.url ?? url;

  // stdout is the command's: what Terrarium says goes to stderr.
  console.error(
    `terrarium: ${started ? "started a sandbox" : "using the sandbox"} at ${control}`
  );

  const child = spawn(command, {
    shell: true,
    stdio: "inherit",
    env: {
      ...process.env,
      TERRARIUM_URL: control,
      NODE_OPTIONS: [process.env["NODE_OPTIONS"], `--import ${register.href}`]
        .filter(Boolean)
        .join(" "),
      ...(unowned !== undefined && { TERRARIUM_UNOWNED: unowned })
    }
  });
  // A Ctrl+C reaches the command from the terminal too; a signal sent to Terrarium alone is passed on. Either way, the sandbox stops after the command does.
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };

  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);

  try {
    return await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => {
        resolve(code ?? 1);
      });
    });
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
    await started?.close();
  }
};
