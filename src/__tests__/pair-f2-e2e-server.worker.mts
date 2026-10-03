/**
 * F2 R1.7 E2E server worker — a REAL PAIR mission-control HTTP server in
 * a separate OS process, sharing the parent's pair.db (WAL multi-process,
 * same model as the R4.2 true-concurrency proof). The parent test calls
 * the live /api/outbox + /api/artifacts/fetch lanes over real HTTP.
 */
import {
  PairEvidenceStore,
  PairControlPlane,
  MissionControl,
  createMissionControlServer,
} from "../pair/index.js";

const dbPath = process.argv[2]!;
const master = process.argv[3]!;
process.env.PAIR_ARTIFACT_UPLOAD_TOKEN = master;

const store = new PairEvidenceStore(dbPath);
const service = new PairControlPlane(store);
const control = new MissionControl({ service } as never);
const server = createMissionControlServer({
  control,
  artifactUploadToken: master,
} as never);
server.listen(0, "127.0.0.1", () => {
  const addr = server.address() as { port: number };
  process.stdout!.write(`PORT ${addr.port}\n`);
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 60_000);
