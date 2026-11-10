-- A coach removed or declined by a club may withdraw that record and request again.
drop policy "coach_clubs: coach withdraws" on coach_clubs;
create policy "coach_clubs: coach withdraws" on coach_clubs for delete
  using (coach_id = my_coach_id() and status in ('pending', 'declined', 'removed'));
