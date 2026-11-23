import { control } from "./control";
import { filterFrom } from "./jetstream";
import { serve } from "./serve";
import {
  createTerrarium,
  DEFAULT_HOST,
  DEFAULT_PORTS,
  type Terrarium
} from "./terrarium";

/**
 * Terrarium as a running server, for anything outside this process: the CLI, a browser, an app under development, a device on the LAN. Every PDS answers on its own port; the PLC directory and the control API on theirs.
 */

export const DEFAULT_CONTROL_PORT = 2580;

export interface ServerOptions {
  readonly dir?: string;
  readonly host?: string;
  readonly port?: number;
  readonly ports?: {
    readonly plc: number;
    readonly jetstream: number;
    readonly pds: number;
  };
}

export interface Server {
  /** The control API. */
  readonly url: string;
  /** The PLC directory on a local port, for clients nothing intercepts. Intercepted clients use `https://plc.directory`. */
  readonly plcUrl: string;
  /** Jetstream on a local port, for clients nothing intercepts. Intercepted clients use Bluesky's own Jetstream addresses. */
  readonly jetstreamUrl: string;
  readonly terrarium: Terrarium;
  close(): Promise<void>;
}

/** Whether a sandbox's control API answers at `url`. */
export const isRunning = async (url: string): Promise<boolean> => {
  try {
    return (await fetch(`${url}/health`)).ok;
  } catch {
    return false;
  }
};

export const startServer = async ({
  dir,
  host = DEFAULT_HOST,
  port = DEFAULT_CONTROL_PORT,
  ports = DEFAULT_PORTS
}: ServerOptions = {}): Promise<Server> => {
  const terrarium = await createTerrarium({
    ...(dir !== undefined && { dir }),
    host,
    ports,
    listen: true
  });
  const api = await serve(control(terrarium), { host, port });
  // Whatever host a client used, it's the PLC directory it asked for.
  const plc = await serve(
    async (request) => {
      const { pathname, search } = new URL(request.url);

      return terrarium.fetch(
        new Request(`${terrarium.plcUrl}${pathname}${search}`, request)
      );
    },
    { host, port: ports.plc }
  );
  const jetstream = await serve(async (request) => terrarium.fetch(request), {
    host,
    port: ports.jetstream,
    upgrade(url, socket) {
      if (url.pathname !== "/subscribe") {
        socket.close(1008, "Jetstream subscribes at /subscribe.");

        return;
      }

      const stop = terrarium.jetstream.subscribe(filterFrom(url), (event) => {
        socket.send(JSON.stringify(event));
      });

      socket.on("close", stop);
    }
  });

  return {
    url: api.url,
    plcUrl: plc.url,
    jetstreamUrl: `${jetstream.url.replace(/^http/u, "ws")}/subscribe`,
    terrarium,
    async close() {
      await Promise.all([api.close(), plc.close(), jetstream.close()]);
      await terrarium.dispose();
    }
  };
};
