# Change Detection POC

Created this  poc for detecting changes in the Oracle SAM database using a simple polling approach with hash comparison

---

## Quick Start

```bash
npm run compose:up

# Wait for Oracle and then run integration tests
node test/integration/change-detection.test.js
```

**Tests verify:**
- CREATE detection (baseline poll)
- UPDATE detection (name change)
- False positive avoidance (timestamp-only updates ignored)
- DELETE detection

---

## Some Questions

**Q: Does this work without UPDATED_DATETIME columns?**
A: No. If columns don't exist, we need different approach (triggers or CDC).

**Q: What if child table (PERSON) updates but parent (PARTY) doesn't?**
A: GREATEST() in query checks all related table timestamps. Change detected.

**Q: Why not use Oracle CDC?**
A: Polling approach requires no Oracle schema changes or special permissions. IBM may prefer this for approval reasons.

**Q: How do we avoid full table scans?**
A: Ensure indexes exist on UPDATED_DATETIME columns.

**Q: What's the Oracle performance impact?**
A: <100 queries/min for 38 tables (1 query per table every 30-45s). Minimal if indexes exist.

**Q: How do we handle false positives (timestamp updates without data changes)?**
A: Hash comparison prevents false positives. Only emit events when hash actually changes.

**Q: Can we scale this to all 38 SAM tables?**
A: Yes. Add table config to `table-config.js` and implement payload method in `PayloadCalculator.js`. 