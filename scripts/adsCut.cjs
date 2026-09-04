/**
 * Срез рекламных расходов Ozon (вариант Б, фаза 0).
 *
 * Использование (внутри контейнера):
 *   node scripts/adsCut.cjs <store_id> [--apply] [--factor=0.5]
 *   node scripts/adsCut.cjs <store_id> --list          # только список кампаний
 *
 * Без --apply — dry-run: печатает план (что деактивирует, какие бюджеты порежет).
 * Ключи Performance API кладутся заранее:
 *   node -e "require('./db/strategies.cjs').setAppSetting('perf_api_<store_id>', JSON.stringify({client_id:'...',client_secret:'...'}))"
 */
const perf = require('../lib/ozonPerformance.cjs');

(async () => {
    const [storeId, ...flags] = process.argv.slice(2);
    if (!storeId) { console.error('Usage: node scripts/adsCut.cjs <store_id> [--apply] [--factor=0.5] [--list]'); process.exit(1); }
    const apply = flags.includes('--apply');
    const factorFlag = flags.find(f => f.startsWith('--factor='));
    const budgetFactor = factorFlag ? parseFloat(factorFlag.split('=')[1]) : 0.5;

    if (flags.includes('--list')) {
        const list = await perf.listCampaigns(storeId);
        for (const c of list) console.log(JSON.stringify({ id: c.id, title: c.title, state: c.state, type: c.advObjectType, dailyBudget: c.dailyBudget, budget: c.budget }));
        console.log(`total: ${list.length}`);
        return;
    }

    const res = await perf.cutAds(storeId, { dryRun: !apply, budgetFactor });
    console.log(`${res.dryRun ? 'DRY-RUN (план, ничего не изменено)' : 'ПРИМЕНЕНО'} — кампаний всего: ${res.total}`);
    for (const a of res.actions) console.log(JSON.stringify(a));
})().catch(e => { console.error('ERR:', e.response?.status, JSON.stringify(e.response?.data || e.message).slice(0, 300)); process.exit(1); });
