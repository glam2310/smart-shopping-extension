module.exports = {
    CACHE_TTL_HOURS: Number(process.env.CACHE_TTL_HOURS || 24),
    PASSIVE_DWELL_TIME_SEC: Number(process.env.PASSIVE_DWELL_TIME_SEC || 30),

    COMPARE_TARGET_SITES: [
        'shop.super-pharm.co.il',
        '365mashbir.co.il',
        'www.shufersal.co.il'
    ],

    ORIGIN_SITES: [
        'shop.super-pharm.co.il',
        '365mashbir.co.il',
        'www.shufersal.co.il',
        'ksp.co.il'
    ]
};
