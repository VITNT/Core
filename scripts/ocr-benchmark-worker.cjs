// Node ignores corePath. Match the ordinary SIMD core used by the browser;
// Tesseract.js 7's relaxed-SIMD float-model path aborts (upstream issue #1080).
const path = require('node:path');
const worker = require.resolve('tesseract.js/src/worker-script/node/index.js');
const detection = require.resolve('wasm-feature-detect', { paths: [path.dirname(worker)] });
const detect = require(detection);
require.cache[detection].exports = { ...detect, relaxedSimd: async () => false };
require(worker);
