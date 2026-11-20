import { control } from "./control";
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
  readonly ports?: { readonly plc: number; readonly pds: number };
}

export interface Server {
  /** The control API. */
  readonly url: string;
  readonly plcUrl: string;
  readonly terrarium: Terrarium;
  close(): Promise<void>;
}

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

  return {
    url: api.url,
    plcUrl: terrarium.plcUrl,
    terrarium,
    async close() {
      await Promise.all([api.close(), plc.close()]);
      await terrarium.dispose();
    }
  };
};
