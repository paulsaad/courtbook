-- Round 3 of the review found that an absent row is not proof of refusal: if the publishing
-- transaction is still running — blocked on the club lock, say — a read sees nothing, and the route
-- would delete a file that the transaction then commits a reference to. The route now preserves any
-- object whose outcome it cannot establish and records the path here for later reconciliation.
--
-- That moves the decision to this list, so the list must not offer a path that something now
-- references. A precautionary entry for a transaction that went on to commit is harmless only if
-- whoever sweeps cannot act on it.
create or replace function media_orphans_list() returns setof media_orphans
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return query
    select o.* from media_orphans o
    where o.cleared_at is null
      and not exists (select 1 from club_media m where m.path = o.path)
    order by o.noticed_at;
end $$;
revoke execute on function media_orphans_list() from public, anon;
grant execute on function media_orphans_list() to authenticated;
