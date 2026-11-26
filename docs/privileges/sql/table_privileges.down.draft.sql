-- Rollback of table_privileges.draft.sql: re-grants exactly what it removed (DRAFT; applied nowhere).
-- Exactly the 29 tables and 2 views on which players held all three before the draft (measured on 0001–0093; visitors held none).
do $$
declare t text;
begin
  foreach t in array array['occupancy', 'public_occupancy', 'account_deletions', 'app_settings', 'availability_exceptions', 'availability_rules', 'blocks', 'bookings', 'club_media', 'club_payouts', 'club_staff', 'clubs', 'coach_clubs', 'coaches', 'courts', 'credit_packs', 'credit_transactions', 'districts', 'governorates', 'match_hidden', 'match_messages', 'match_players', 'matches', 'media_orphans', 'notifications', 'payments', 'player_blocks', 'player_levels', 'price_rules', 'profiles', 'sports'] loop
    execute format('grant truncate, trigger, references on public.%I to authenticated', t);
  end loop;
end $$;
alter default privileges for role postgres in schema public grant truncate, trigger, references on tables to authenticated;

grant insert, update, delete on public.app_settings        to authenticated;
grant insert                 on public.blocks              to authenticated;
grant insert, update         on public.bookings            to authenticated;
grant insert, update, delete on public.club_media          to authenticated;
grant update                 on public.coach_clubs         to authenticated;
grant update, delete         on public.credit_transactions to authenticated;
grant insert, update, delete on public.match_hidden        to authenticated;
grant update, delete         on public.match_messages      to authenticated;
grant insert, update, delete on public.match_players       to authenticated;
grant insert, update         on public.matches             to authenticated;
grant insert, update, delete on public.media_orphans       to authenticated;
grant insert, delete         on public.notifications       to authenticated;
grant insert, update, delete on public.payments            to authenticated;
grant insert, update, delete on public.player_levels       to authenticated;
grant insert, delete         on public.profiles            to authenticated;
