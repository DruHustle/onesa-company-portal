'use strict';

// The pinned legacy consumers require a callable CommonJS export and/or its
// Minimatch constructor. Both are supplied unchanged by the fixed upstream.
module.exports = require('minimatch-fixed').minimatch;
