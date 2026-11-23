import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { z } from "zod";

import { createSystemCredentialStore } from "../system-store.js";

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk.toString();
  const { service, providerId, key } = z.object({
    service: z.string(), providerId: z.string(), key: z.string(),
  }).strict().parse(JSON.parse(input));
  const credentials = createSystemCredentialStore(service);
  const credential = await credentials.read(providerId);
  const metadata = await credentials.list();
  const models = builtinModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const auth = await models.getAuth(providerId);
  process.stdout.write(JSON.stringify({
    restored: credential?.type === "api_key" && credential.key === key,
    resolved: auth?.auth.apiKey === key,
    listed: metadata.some((item) => item.providerId === providerId && item.type === "api_key"),
  }) + "\n");
}

main().catch(() => {
  process.stderr.write("Credential subprocess verification failed\n");
  process.exitCode = 1;
});
