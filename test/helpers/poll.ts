export interface PollOptions {
  timeout?: number;
  interval?: number;
}

export async function poll(
  fn: () => boolean | Promise<boolean>,
  options: PollOptions = {},
): Promise<void> {
  const { timeout = 5_000, interval = 100 } = options;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await fn()) {
      return;
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(`poll: timed out after ${timeout}ms`);
}
