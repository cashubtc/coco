/** Enqueue a committed event for publication after the owning coordinator releases its locks. */
export type DeferPublication = (publish: () => Promise<void>) => void;

export async function publishOrDefer(
  publish: () => Promise<void>,
  defer?: DeferPublication,
): Promise<void> {
  if (defer) defer(publish);
  else await publish();
}
