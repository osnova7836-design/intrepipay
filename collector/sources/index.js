// Single source of truth for registered collector sources — both server.js (inline
// usage) and collector/index.js (standalone service) require this instead of keeping
// their own copies of this list. A source that only exists as a file in this directory
// but isn't required here silently never runs (see: Frontdoor 2026-06-19, Assurant
// 2026-08-26 — both cost a session of debugging "why didn't it run" with no error).
module.exports = {
  rely:               require('./rely'),
  lula:                require('./lula'),
  orhp:                require('./orhp'),
  'two-ten':           require('./two-ten'),
  rheem:               require('./rheem'),
  'first-american':    require('./first-american'),
  lessen:              require('./lessen-sms-assist'),
  frontdoor:           require('./frontdoor'),
  cinch:               require('./cinch'),
  homeserve:           require('./homeserve'),
  'all-county-first':  require('./all-county-first'),
  assurant:            require('./assurant'),
};
