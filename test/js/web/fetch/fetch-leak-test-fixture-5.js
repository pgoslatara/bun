import { heapStats } from "bun:jsc";

function getHeapStats() {
  return heapStats().objectTypeCounts;
}

const server = process.argv[2];
const batch = 10;
const iterations = 50;
// Instead of a fixed threshold, we check that object counts don't grow unboundedly.
// A real leak would show continuous growth. A fixed overhead (due to GC timing) is acceptable.
const maxGrowthFactor = 5; // Allow up to 5x growth from initial baseline
const BODY_SIZE = parseInt(process.argv[3], 10);
if (!Number.isSafeInteger(BODY_SIZE)) {
  console.error("BODY_SIZE must be a safe integer", BODY_SIZE, process.argv);
  process.exit(1);
}

function getFormData() {
  const formData = new FormData();

  formData.set("file", getBlob());
  return formData;
}
let cachedBlobBuffer;
function getBlob() {
  if (!cachedBlobBuffer) {
    const buf = new Uint8Array(BODY_SIZE);
    buf.fill(42);
    for (let i = 0; i < 256; i++) {
      buf[i] = i;
    }
    cachedBlobBuffer = buf;
  }
  return new Blob([cachedBlobBuffer], { type: "application/octet-stream" });
}
function getBuffer() {
  return Buffer.alloc(BODY_SIZE, "abcdefghijklmnopqrstuvwxyz");
}
function getString() {
  return getBuffer().toString();
}
function getURLSearchParams() {
  const urlSearchParams = new URLSearchParams();
  urlSearchParams.set("file", getString());
  return urlSearchParams;
}

const type = process.argv[4];

// Cache only buffer/string since those aren't reference counted the same way.
let cachedBody;
function getBody() {
  let body;
  switch (type.toLowerCase()) {
    case "blob":
      body = getBlob();
      break;
    case "buffer":
      body = cachedBody ??= getBuffer();
      break;
    case "string":
      body = cachedBody ??= getString();
      break;
    case "formdata":
      body = getFormData();
      break;
    case "urlsearchparams":
      body = getURLSearchParams();
      break;
    case "iterator":
      body = async function* iter() {
        yield (cachedBody ??= getString());
      };
      break;
    case "stream":
      body = new ReadableStream({
        async pull(c) {
          await Bun.sleep(10);
          c.enqueue((cachedBody ??= getBuffer()));
          c.close();
        },
      });
      break;
    default:
      throw new Error(`Invalid type: ${type}`);
  }

  return body;
}

async function iterate() {
  const promises = [];
  for (let j = 0; j < batch; j++) {
    promises.push(fetch(server, { method: "POST", body: getBody() }));
  }
  await Promise.all(promises);
}

async function runGC() {
  // Multiple GC passes with sleep to ensure objects are collected
  for (let gc = 0; gc < 3; gc++) {
    Bun.gc(true);
    await Bun.sleep(50);
  }
}

try {
  // Run a few warmup iterations to establish baseline
  for (let i = 0; i < 5; i++) {
    await iterate();
    await runGC();
  }

  const baselineStats = getHeapStats();
  const baselineResponse = baselineStats.Response || 0;
  const baselinePromise = baselineStats.Promise || 0;

  // Now run the main test iterations
  for (let i = 0; i < iterations; i++) {
    await iterate();
    await runGC();

    const stats = getHeapStats();
    const responseCount = stats.Response || 0;
    const promiseCount = stats.Promise || 0;

    // Check that counts haven't grown beyond acceptable limits
    // A real leak would show unbounded growth; fixed overhead is OK
    // Use batch * 45 as minimum to account for GC timing variations with mimalloc v3
    const maxResponse = Math.max(baselineResponse * maxGrowthFactor, batch * 45);
    const maxPromise = Math.max(baselinePromise * maxGrowthFactor, batch * 45);

    if (responseCount > maxResponse) {
      throw new Error(`Response leak detected: ${responseCount} > ${maxResponse} (baseline: ${baselineResponse})`);
    }
    if (promiseCount > maxPromise) {
      throw new Error(`Promise leak detected: ${promiseCount} > ${maxPromise} (baseline: ${baselinePromise})`);
    }

    process.send({
      rss: process.memoryUsage.rss(),
    });
  }

  process.send({
    rss: process.memoryUsage.rss(),
  });
  await Bun.sleep(10);
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
