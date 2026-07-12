require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');

const sources = {
  rely:             require('./sources/rely'),
  lula:             require('./sources/lula'),
  orhp:             require('./sources/orhp'),
  'two-ten':        require('./sources/two-ten'),
  rheem:            require('./sources/rheem'),
  'first-american': require('./sources/first-american'),
  lessen:           require('./sources/lessen-sms-assist'),
  cinch:            require('./sources/cinch'),
  homeserve:        require('./sources/homeserve'),
  frontdoor:        require('./sources/frontdoor'),
  'all-county-first': require('./sources/all-county-first'),
};

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', sources: Object.keys(sources) }));

// POST /collect
// Body (optional): { companies: ['rely', 'lula'], daysBack: 30 }
// Returns: { results: [...], errors: { company: message } }
app.post('/collect', async (req, res) => {
  const { companies, daysBack = 30 } = req.body || {};
  const targets = companies?.length
    ? companies.filter(c => sources[c])
    : Object.keys(sources);

  console.log(`[collector] Running: ${targets.join(', ')} (daysBack=${daysBack})`);

  const allResults = [];
  const errors = {};

  // Run portal sources sequentially to avoid memory pressure from multiple browsers
  // Email sources are fast and can tolerate sequential too
  for (const name of targets) {
    console.log(`[collector] Starting ${name}...`);
    try {
      const results = await sources[name].collect({ daysBack });
      allResults.push(...results);
      console.log(`[collector] ${name}: ${results.length} payments`);
    } catch (err) {
      console.error(`[collector] ${name} FAILED: ${err.message}`);
      errors[name] = err.message;
    }
  }

  console.log(`[collector] Done. Total: ${allResults.length} payments, ${Object.keys(errors).length} errors`);
  res.json({ results: allResults, errors, total: allResults.length });
});

// GET /collect/:company — run a single source
app.get('/collect/:company', async (req, res) => {
  const { company } = req.params;
  const daysBack = parseInt(req.query.daysBack) || 30;
  const source = sources[company];

  if (!source) {
    return res.status(404).json({ error: `Unknown company: ${company}. Available: ${Object.keys(sources).join(', ')}` });
  }

  try {
    const results = await source.collect({ daysBack });
    res.json({ results, total: results.length });
  } catch (err) {
    console.error(`[collector] ${company} FAILED: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.COLLECTOR_PORT || process.env.PORT || 3001;
app.listen(PORT, () => console.log(`[collector] Listening on port ${PORT}`));
