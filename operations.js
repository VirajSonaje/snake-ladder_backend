class RequestError extends Error {
  constructor(message) {super(message);this.name='RequestError';}
}
// Fixed-window request budgets; stores keys only until the next expiry sweep.
function createLimiter({limit, windowMs, now = Date.now}) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs <= 0) throw Error('Invalid request limit configuration.');
  const buckets = new Map();
  return {
    consume(key) {
      const time=now();
      let bucket=buckets.get(key);
      if (!bucket || time >= bucket.expiresAt) {bucket={count:0,expiresAt:time+windowMs};buckets.set(key,bucket);}
      bucket.count++;
      return {allowed:bucket.count<=limit, firstDenied:bucket.count===limit+1, retryAfterMs:Math.max(0,bucket.expiresAt-time)};
    },
    remove(key) {buckets.delete(key);},
    sweep() {const time=now();for(const [key,bucket] of buckets) if(time>=bucket.expiresAt) buckets.delete(key);},
    clear() {buckets.clear();}
  };
}
module.exports={createLimiter,RequestError};
