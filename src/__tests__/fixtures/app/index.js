/* oxlint-disable eslint/no-undef -- a Worker's globals (fetch, URL, Response), which this linter's environment doesn't declare */
// Reads an account the way any ATProto app does: its DID at plc.directory, then the PDS that names.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/env") {
      return Response.json({
        greeting: env.GREETING,
        secret: env.SECRET,
        origin: env.ORIGIN
      });
    }

    const did = url.searchParams.get("did");
    const document = await (await fetch(`https://plc.directory/${did}`)).json();

    return Response.json({ pds: document.service[0].serviceEndpoint });
  }
};
