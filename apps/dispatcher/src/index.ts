/**
 * raft-dispatcher Worker — T8.1 fills this in.
 *
 * Will:
 *  - Parse hostname `pr-<n>--<repo-slug>.preview.<base>` (PRD amendment A4).
 *  - Look up `script_name` in KV (populated by control during ProvisionPR step 7).
 *  - Forward request via `env.DISPATCHER.get(scriptName).fetch(req)`.
 */
interface DispatcherEnv {
  readonly DISPATCHER: DispatchNamespace;
}

const handler: ExportedHandler<DispatcherEnv> = {
  fetch(_req, _env, _ctx) {
    return new Response('raft-dispatcher: not yet implemented (T8.1)', { status: 503 });
  },
};

// eslint-disable-next-line import-x/no-default-export -- Workers entrypoint.
export default handler;
