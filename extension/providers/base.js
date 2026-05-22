// providers/base.js
// ModelProvider base class — kept in its own file to break the circular
// dependency between provider.js (factory) and the concrete adapters.

export class ModelProvider {
  /** Human-readable name shown in the side panel. */
  get name() { throw new Error('not implemented'); }

  /**
   * Async generator that yields string chunks.
   * Throws on API / network errors so callers can display them.
   *
   * @param {Array<{role:'user'|'assistant', content:string}>} messages
   * @param {string} system  System prompt (empty string = no system message)
   */
  async *stream(_messages, _system) { return; } // eslint-disable-line require-yield

  /**
   * Sends a minimal request to verify credentials / reachability.
   * Resolves with { ok: true, name } or { ok: false, error }.
   */
  async test() { return { ok: true, name: this.name }; }
}
