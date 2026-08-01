import {
  canonicalProofEnvelopeJson,
  canonicalProvisionalProof,
  proofChecksum,
  validateProofEnvelope,
} from "../src/stockProof";

const [command, source, first, second, third] = process.argv.slice(2);
if (!command || !source) throw new TypeError("usage: stock-proof-cli.ts <command> <source> ...");
const value = await Bun.file(source).json();

if (command === "validate-provisional") {
  if (!first) throw new TypeError("expected run ID is required");
  canonicalProvisionalProof(value, first);
} else if (command === "publish") {
  if (!first || !second) throw new TypeError("output path and expected identity are required");
  const candidateSha = third;
  if (!candidateSha) throw new TypeError("candidate SHA is required");
  const checksum = await proofChecksum(value);
  const envelope = canonicalProofEnvelopeJson(value, checksum);
  await validateProofEnvelope(JSON.parse(envelope), { runId: second, candidateSha });
  await Bun.write(first, envelope);
} else if (command === "validate-envelope") {
  if (!first || !second) throw new TypeError("expected identity is required");
  await validateProofEnvelope(value, { runId: first, candidateSha: second });
} else {
  throw new TypeError("unknown stock proof command");
}
