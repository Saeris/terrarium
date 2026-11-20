import {
  Request as WorkerRequest,
  Response as WorkerResponse
} from "miniflare";

/**
 * Requests and responses across the line between Node and Miniflare, which has its own `Request` and `Response`. Redirects are never followed on the way: an OAuth sign-in is a chain of them, and the browser has to see each one.
 */

const bodyOf = async (
  message: Request | WorkerRequest
): Promise<ArrayBuffer | undefined> =>
  message.body ? message.arrayBuffer() : undefined;

/** A request a worker made, as a standard one. */
export const fromWorker = async (request: WorkerRequest): Promise<Request> => {
  const body = await bodyOf(request);

  return new Request(request.url, {
    method: request.method,
    headers: [...request.headers],
    redirect: "manual",
    ...(body !== undefined && { body })
  });
};

/** A standard request, for Miniflare to dispatch to a worker. */
export const toWorker = async (request: Request): Promise<WorkerRequest> => {
  const body = await bodyOf(request);

  return new WorkerRequest(request.url, {
    method: request.method,
    headers: [...request.headers],
    redirect: "manual",
    ...(body !== undefined && { body })
  });
};

/** A standard response, as a worker's `fetch` returns it. */
export const responseToWorker = async (
  response: Response
): Promise<WorkerResponse> =>
  new WorkerResponse(
    response.status === 204 || response.status === 304
      ? null
      : await response.arrayBuffer(),
    {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers]
    }
  );

/** A worker's response, as a standard one. */
export const responseFromWorker = async (
  response: WorkerResponse
): Promise<Response> =>
  new Response(
    response.status === 204 || response.status === 304
      ? null
      : await response.arrayBuffer(),
    {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers]
    }
  );
