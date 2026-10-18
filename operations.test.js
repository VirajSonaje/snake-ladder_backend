const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createLimiter}=require('./operations');
test('request windows enforce a boundary, recover, and separate keys',()=>{
 let time=100;const limiter=createLimiter({limit:2,windowMs:50,now:()=>time});
 assert.equal(limiter.consume('a').allowed,true);assert.equal(limiter.consume('a').allowed,true);
 assert.deepEqual(limiter.consume('a'),{allowed:false,firstDenied:true,retryAfterMs:50});
 assert.equal(limiter.consume('a').firstDenied,false);assert.equal(limiter.consume('b').allowed,true);
 time=150;limiter.sweep();assert.equal(limiter.consume('a').allowed,true);
 limiter.remove('a');assert.equal(limiter.consume('a').allowed,true);limiter.clear();
 assert.throws(()=>createLimiter({limit:0,windowMs:10}));
});
