/** Retain successful data and reject only responses older than an applied result. */
export class Snapshot<T> {
  private value: T | null = null;
  private event = 0;
  private started = 0;
  private applied = 0;
  get() { return this.value; }
  receive(value: T) { ++this.event; this.value = value; }
  async read(fetch: () => Promise<T>): Promise<T> {
    const request = ++this.started;
    const event = this.event;
    const value = await fetch();
    if (event === this.event && request > this.applied) {
      this.applied = request;
      this.value = value;
    }
    return this.value ?? value;
  }
}
