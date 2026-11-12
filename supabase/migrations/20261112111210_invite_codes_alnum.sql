-- Invite codes used base64url, so about 1 in 64 started with "-" and the CLI parsed it as an
-- option. Use lowercase hex instead: no punctuation, safe to paste anywhere.
alter table public.invites
  alter column code set default encode(extensions.gen_random_bytes(9), 'hex');
