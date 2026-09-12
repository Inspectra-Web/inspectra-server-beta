import { MongoClient } from "mongodb";

import envConfig from "../config/env.config.js";

/**
 * Copies every collection from one database into another, document for document.
 *
 * Written to lift the local development database into Atlas, but it is not specific to
 * that: the source is MIGRATE_FROM and the destination is whatever MONGO_URI currently
 * points at, so it also serves to reseed a fresh environment from a known-good one.
 *
 * It uses the driver rather than mongodump, which is not installed, and rather than
 * Compass's JSON export, which flattens ObjectIds and Dates unless every collection is
 * hand-walked through EJSON. Nothing here is ever serialised: BSON comes out of one
 * connection and goes straight into the other, so types, nested sub-documents and _ids
 * survive exactly. Keeping the _ids is what lets existing sessions and every reference
 * between collections keep working after the move.
 *
 * Idempotent by construction: each document is a replaceOne upsert keyed on its own
 * _id, so running it twice changes nothing the second time and a half-finished run can
 * simply be repeated. It never writes to the source.
 *
 * Indexes are deliberately not copied. Mongoose builds them from the schemas when the
 * server boots, which is the one definition that cannot drift from the models.
 */
const SOURCE = process.env.MIGRATE_FROM ?? "mongodb://127.0.0.1:27017/inspectra";

const migrate = async (): Promise<void> => {
  const from = new MongoClient(SOURCE, { serverSelectionTimeoutMS: 10000 });
  const to = new MongoClient(envConfig.MONGO_URI, { serverSelectionTimeoutMS: 20000 });

  await from.connect();
  await to.connect();

  const src = from.db();
  const dst = to.db();

  console.log(`from : ${src.databaseName} (${SOURCE.replace(/\/\/[^@]*@/, "//***@")})`);
  console.log(`to   : ${dst.databaseName} (${dst.client.options.hosts?.[0] ?? "?"})\n`);

  const collections = await src.listCollections().toArray();
  let moved = 0;

  for (const { name } of collections) {
    const docs = await src.collection(name).find({}).toArray();

    if (docs.length === 0) {
      console.log(`  ${name.padEnd(16)} empty, skipped`);
      continue;
    }

    const result = await dst.collection(name).bulkWrite(
      docs.map((doc) => ({
        replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
      })),
      { ordered: false },
    );

    moved += docs.length;
    console.log(
      `  ${name.padEnd(16)} ${String(docs.length).padStart(4)} read  ` +
        `${String(result.upsertedCount).padStart(4)} inserted  ` +
        `${String(result.modifiedCount).padStart(4)} replaced`,
    );
  }

  console.log(`\nVerifying...`);
  let mismatch = false;

  for (const { name } of collections) {
    const [a, b] = await Promise.all([
      src.collection(name).countDocuments(),
      dst.collection(name).countDocuments(),
    ]);

    if (a !== b) {
      mismatch = true;
      console.log(`  ${name.padEnd(16)} MISMATCH  source ${a}, destination ${b}`);
    }
  }

  console.log(
    mismatch
      ? "\nCounts do not match. Nothing was removed; re-run to retry."
      : `\nEvery collection matches. ${moved} document(s) in place.`,
  );

  await from.close();
  await to.close();
  process.exit(mismatch ? 1 : 0);
};

migrate().catch(async (error: unknown) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
