/**
 * The parts of Bluesky's AppView that apps lean on for accounts: finding one as someone types, showing its profile, resolving a handle. Answered from the sandbox's own accounts, so a sign-in field's suggestions list the accounts a test made, and nothing is asked of the real AppView. Anything else gets "not implemented" rather than a trip to the network.
 */

/** Where apps reach the AppView. */
export const APPVIEW_HOSTS: ReadonlySet<string> = new Set([
  "public.api.bsky.app",
  "api.bsky.app"
]);

export interface Profile {
  readonly displayName?: string | undefined;
  readonly description?: string | undefined;
}

/** How the AppView shows an account. */
interface ActorView {
  readonly did: string;
  readonly handle: string;
  readonly displayName?: string;
  readonly description?: string;
}

export interface AppViewAccount {
  readonly did: string;
  readonly handle: string;
  /** The account's `app.bsky.actor.profile`, if it has one. */
  readonly profile: () => Promise<Profile | undefined>;
}

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

const view = async (account: AppViewAccount): Promise<ActorView> => {
  const profile = await account.profile();

  return {
    did: account.did,
    handle: account.handle,
    ...(profile?.displayName !== undefined && {
      displayName: profile.displayName
    }),
    ...(profile?.description !== undefined && {
      description: profile.description
    })
  };
};

export const appview =
  (accounts: () => readonly AppViewAccount[]) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const method = url.pathname.replace(/^\/xrpc\//u, "");
    const find = (actor: string): AppViewAccount | undefined =>
      accounts().find(({ did, handle }) => did === actor || handle === actor);

    switch (method) {
      case "app.bsky.actor.searchActorsTypeahead":
      case "app.bsky.actor.searchActors": {
        const query = (
          url.searchParams.get("q") ??
          url.searchParams.get("term") ??
          ""
        ).toLowerCase();
        const limit = Number(url.searchParams.get("limit") ?? 10);
        const views = await Promise.all(accounts().map(view));
        const actors = views
          .filter(
            ({ handle, displayName }) =>
              query !== "" &&
              (handle.startsWith(query) ||
                (displayName ?? "").toLowerCase().includes(query))
          )
          .slice(0, limit);

        return json({ actors });
      }
      case "app.bsky.actor.getProfile": {
        const account = find(url.searchParams.get("actor") ?? "");

        return account
          ? json(await view(account))
          : json(
              { error: "InvalidRequest", message: "Profile not found" },
              400
            );
      }
      case "app.bsky.actor.getProfiles": {
        const found = url.searchParams
          .getAll("actors")
          .map(find)
          .filter((account) => account !== undefined);

        return json({ profiles: await Promise.all(found.map(view)) });
      }
      case "com.atproto.identity.resolveHandle": {
        const account = find(url.searchParams.get("handle") ?? "");

        return account
          ? json({ did: account.did })
          : json(
              { error: "InvalidRequest", message: "Unable to resolve handle" },
              400
            );
      }
      default: {
        return json(
          {
            error: "MethodNotImplemented",
            message: `Terrarium's AppView doesn't implement ${method}.`
          },
          501
        );
      }
    }
  };
