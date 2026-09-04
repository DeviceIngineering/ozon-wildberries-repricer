const { db } = require('./connection.cjs');

module.exports = {
    ...require('./stores.cjs'),
    ...require('./products.cjs'),
    ...require('./logs.cjs'),
    ...require('./imports.cjs'),
    ...require('./pending.cjs'),
    ...require('./snapshots.cjs'),
    ...require('./scheduling.cjs'),
    ...require('./dashboard.cjs'),
    ...require('./analytics.cjs'),
    ...require('./sales.cjs'),
    ...require('./strategies.cjs'),
    ...require('./masterPrices.cjs'),
    ...require('./externalApi.cjs'),
    ...require('./governance.cjs'),
    db,
};
