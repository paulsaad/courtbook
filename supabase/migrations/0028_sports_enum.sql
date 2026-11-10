-- Phase 6 (a): more sports. Enum values must be added outside the transaction that uses them,
-- so this file contains nothing else. Run it alone, then 0029.
alter type sport add value if not exists 'football';
alter type sport add value if not exists 'basketball';
alter type sport add value if not exists 'volleyball';
alter type sport add value if not exists 'squash';
