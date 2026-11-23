import type { SecretBackend } from "../system-store.js";

export function memoryBackend() {
  const values = new Map<string, string>();
  const backend: SecretBackend = {
    read: async (id) => values.get(id) ?? null,
    write: async (id, value) => { values.set(id, value); },
    delete: async (id) => { values.delete(id); },
    list: async () => [...values].map(([account, password]) => ({ account, password })),
  };
  return { backend, values };
}
