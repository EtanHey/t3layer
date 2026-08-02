import {
  canonicalProofEnvelopeJson,
  canonicalProvisionalProof,
  proofChecksum,
  validateProofEnvelope,
} from "../src/stockProof";
import type { ProviderAuthProvenance } from "../src/stockProof";

const [command, source, first, second, third, fourth] = process.argv.slice(2);
if (!command || !source) throw new TypeError("usage: stock-proof-cli.ts <command> <source> ...");
const value = await Bun.file(source).json();
const expectedProviderAuth = (raw: string | undefined): ProviderAuthProvenance => {
  if (!raw) throw new TypeError("expected provider auth is required");
  return JSON.parse(raw) as ProviderAuthProvenance;
};

if (command === "validate-provisional") {
  if (!first) throw new TypeError("expected run ID is required");
  canonicalProvisionalProof(value, first);
} else if (command === "publish") {
  if (!first || !second) throw new TypeError("output path and expected identity are required");
  const candidateSha = third;
  if (!candidateSha) throw new TypeError("candidate SHA is required");
  const providerAuth = expectedProviderAuth(fourth);
  const checksum = await proofChecksum(value);
  const envelope = canonicalProofEnvelopeJson(value, checksum);
  await validateProofEnvelope(JSON.parse(envelope), { runId: second, candidateSha, providerAuth });
  await Bun.write(first, envelope);
} else if (command === "validate-envelope") {
  if (!first || !second) throw new TypeError("expected identity is required");
  const providerAuth = expectedProviderAuth(third);
  await validateProofEnvelope(value, { runId: first, candidateSha: second, providerAuth });
} else {
  throw new TypeError("unknown stock proof command");
}
