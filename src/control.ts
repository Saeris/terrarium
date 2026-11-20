import * as v from "valibot";
import type { Terrarium } from "./terrarium";

/**
 * The control API: how the CLI, a test or an agent asks a running sandbox for accounts and fills them with records. Plain JSON over HTTP, so `curl` works as well as the CLI.
 *
 * - `GET /accounts`: every account, with its DID, handle, PDS URL and password.
 * - `POST /accounts` `{ name, handle?, password? }`: a new account on its own PDS.
 * - `GET /accounts/:name`
 * - `POST /accounts/:name/records` `[{ collection, rkey?, record }]`: write records to its repo.
 * - `GET /jetstream`: whether it's paused, and which accounts it ignores.
 * - `POST /jetstream/pause`, `POST /jetstream/resume`: hold events back, then release them, as a relay that falls behind and catches up.
 * - `POST /jetstream/ignore/:name`, `POST /jetstream/heed/:name`: stop carrying an account's events, then start again, as a relay that drops a PDS.
 * - `GET /health`
 */

const newAccountSchema = v.object({
  name: v.string(),
  handle: v.optional(v.string()),
  password: v.optional(v.string())
});

const seedRecordSchema = v.object({
  collection: v.string(),
  rkey: v.optional(v.string()),
  record: v.record(v.string(), v.unknown())
});

/** A list of records, or `{ records }`, so a fixture file can carry other keys beside them. */
const seedSchema = v.union([
  v.array(seedRecordSchema),
  v.pipe(
    v.object({ records: v.array(seedRecordSchema) }),
    v.transform(({ records }) => records)
  )
]);

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

const problem = (error: unknown, status = 400): Response =>
  json(
    {
      error:
        error instanceof v.ValiError
          ? v.summarize(error.issues)
          : error instanceof Error
            ? error.message
            : String(error)
    },
    status
  );

const jetstream = (
  terrarium: Terrarium,
  method: string,
  action: string | undefined,
  name: string | undefined
): Response => {
  const faults = terrarium.jetstream;

  if (method === "GET" && (action === undefined || action === "")) {
    return json(faults.state);
  }

  if (method === "POST" && (action === "pause" || action === "resume")) {
    faults[action]();

    return json(faults.state);
  }

  if (method === "POST" && (action === "ignore" || action === "heed")) {
    const account = name === undefined ? undefined : terrarium.account(name);

    if (!account) {
      return problem(`There's no account called ${String(name)}.`, 404);
    }

    faults[action](account.did);

    return json(faults.state);
  }

  return problem(`Jetstream has no ${String(action)}.`, 404);
};

export const control =
  (terrarium: Terrarium) =>
  async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const [, area, name, sub] = pathname.split("/");

    try {
      if (area === "health") {
        return json({
          plc: terrarium.plcUrl,
          jetstream: terrarium.jetstreamUrl,
          accounts: terrarium.accounts().length
        });
      }

      if (area === "jetstream") {
        return jetstream(terrarium, request.method, name, sub);
      }

      if (area !== "accounts") {
        return problem(`Nothing at ${pathname}.`, 404);
      }

      if (name === undefined || name === "") {
        return request.method === "POST"
          ? json(
              await terrarium.createAccount(
                v.parse(newAccountSchema, await request.json())
              ),
              201
            )
          : json(terrarium.accounts());
      }

      const account = terrarium.account(name);

      if (!account) {
        return problem(`There's no account called ${name}.`, 404);
      }

      if (sub === "records" && request.method === "POST") {
        return json(
          await terrarium.seed(name, v.parse(seedSchema, await request.json())),
          201
        );
      }

      return json(account);
    } catch (error) {
      return problem(error);
    }
  };
