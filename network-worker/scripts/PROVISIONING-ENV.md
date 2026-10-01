/**
 * Document the production environment variable this system depends on.
 *
 * NETPID_STABLE_HOSTS names the host a router may call indefinitely. It is set
 * as a Vercel PRODUCTION environment variable and is deliberately NOT in this
 * repository: committing a hostname couples the codebase to one deployment, and
 * the value is different per environment.
 *
 * Without it, stableCallbackBase() refuses every Vercel host, including the
 * production apex, because a Vercel apex and a preview are the same shape and
 * cannot be told apart by inspection. The result is safe but incomplete: the
 * configure script omits the heartbeat scheduler and says why, so a router is
 * never left permanently calling a deployment that will be deleted.
 *
 *   Production : NETPID_STABLE_HOSTS=netpid.vercel.app
 *   Preview    : unset on purpose. A preview must never become the permanent
 *                heartbeat destination for a real router.
 *
 * Verify with:  node scripts/heartbeat-check.mjs
 */
